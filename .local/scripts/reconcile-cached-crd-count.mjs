#!/usr/bin/env node
// Reconcile `dashboard:cached-crd-count` + local `data/crd-inventory.json.gz`
// with unique coverage-present detail keys in LOCAL Redis.
//
// The app maintains the Redis counter with INCRBY (see incrementInventoryCounterInRedis in
// src/app/api/dashboard/refresh/route.ts), never with a recount, so it drifts whenever
// CRDs land outside the dashboard ingest path (bulk imports, direct writes). It only
// self-heals when missing or 0, so a stale non-zero value stays stale forever.
//
// Prefer the gzip sidecar for cheap totals day-to-day. This script is the rare full
// Redis SCAN that rebuilds the sidecar (and optionally the counter).
//
// Usage:
//   node .local/scripts/reconcile-cached-crd-count.mjs                      # dry run
//   node .local/scripts/reconcile-cached-crd-count.mjs --apply              # local counter + sidecar
//   node .local/scripts/reconcile-cached-crd-count.mjs --sidecar-only --apply
//   node .local/scripts/reconcile-cached-crd-count.mjs --target=prod        # dry run against prod counter
//   node .local/scripts/reconcile-cached-crd-count.mjs --target=prod --apply --yes
//
// Safety: dry run by default. Writing to prod requires BOTH --apply and --yes, and never
// runs a KEYS/SCAN against prod (it only GETs the single counter key for the before value).

import Redis from 'ioredis';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const COUNTER_KEY = 'dashboard:cached-crd-count';
const SIDECAR_PATH = path.join(process.cwd(), 'data', 'crd-inventory.json.gz');
const LOCAL_REDIS_URL = process.env.LOCAL_REDIS_URL || 'redis://127.0.0.1:6379';
// Capture entity type + CRD. FINRA+SEC for the same type:crd merge to one entity;
// firm vs individual stay separate even when the numeric CRD collides.
const DETAIL_KEY_RE = /^(?:finra|sec):(individual|firm):(\d+)$/;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const confirmed = args.has('--yes');
const sidecarOnly = args.has('--sidecar-only');
const target = [...args].find((a) => a.startsWith('--target='))?.split('=')[1] || 'local';

if (!['local', 'prod', 'mirror', 'both'].includes(target)) {
	console.error(`Unknown --target=${target}. Use local | prod | mirror | both.`);
	process.exit(1);
}

// Plain node does not load .env.local, and dotenv is not a dependency here.
function loadLocalEnv() {
	try {
		const raw = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
		for (const line of raw.split('\n')) {
			const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
			if (!match) continue;
			const value = match[2].replace(/^["']|["']$/g, '');
			if (process.env[match[1]] === undefined) process.env[match[1]] = value;
		}
	} catch {
		/* no .env.local is fine */
	}
}

async function countLocalUniqueCrds() {
	const redis = new Redis(LOCAL_REDIS_URL, { maxRetriesPerRequest: 2 });
	const unique = new Set();
	const individuals = new Set();
	const firms = new Set();
	let cursor = '0';
	let scannedKeys = 0;
	let detailKeys = 0;
	do {
		// SCAN rather than KEYS so this stays safe to run against a live instance.
		const [next, batch] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 1000);
		cursor = next;
		for (const key of batch) {
			scannedKeys += 1;
			const match = key.match(DETAIL_KEY_RE);
			if (!match) continue;
			detailKeys += 1;
			const entity = match[1];
			const crd = match[2];
			unique.add(`${entity}:${crd}`);
			(entity === 'individual' ? individuals : firms).add(Number(crd));
		}
	} while (cursor !== '0');
	redis.disconnect();
	return {
		unique: unique.size,
		individuals: individuals.size,
		firms: firms.size,
		individualIds: individuals,
		firmIds: firms,
		scannedKeys,
		detailKeys,
		dualSourceExtraKeys: Math.max(0, detailKeys - unique.size),
	};
}

function writeInventorySidecar(firmIds, individualIds) {
	const firms = Array.from(firmIds).sort((a, b) => a - b);
	const individuals = Array.from(individualIds).sort((a, b) => a - b);
	const payload = {
		version: 1,
		generatedAt: new Date().toISOString(),
		counts: {
			people: individuals.length,
			firms: firms.length,
			unique: firms.length + individuals.length,
		},
		firms,
		individuals,
	};
	mkdirSync(path.dirname(SIDECAR_PATH), { recursive: true });
	const tmp = `${SIDECAR_PATH}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
		renameSync(tmp, SIDECAR_PATH);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw error;
	}
	return payload;
}

async function upstashCommand(url, token, command) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(command),
	});
	if (!res.ok) throw new Error(`Upstash ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return (await res.json()).result;
}

function resolveTargets() {
	const targets = [];
	if (target === 'local') return [{ name: 'local', kind: 'local' }];
	const primary = { name: 'prod (DB1)', kind: 'upstash', url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
	const mirror = {
		name: 'prod (DB2 mirror)',
		kind: 'upstash',
		url: process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2,
		token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2,
	};
	if (target === 'prod' || target === 'both') targets.push(primary);
	if (target === 'mirror' || target === 'both') targets.push(mirror);
	return targets;
}

async function main() {
	loadLocalEnv();

	const counts = await countLocalUniqueCrds();
	console.log(`Local Redis (${LOCAL_REDIS_URL}): scanned ${counts.scannedKeys} keys`);
	console.log(`  detail source keys:     ${counts.detailKeys} (finra:* + sec:*)`);
	console.log(`  unique individual CRDs: ${counts.individuals}`);
	console.log(`  unique firm CRDs:       ${counts.firms}`);
	console.log(`  unique entities total:  ${counts.unique}  (firm|ind CRD; FINRA+SEC merged)`);
	console.log(`  dual-source extra keys: ${counts.dualSourceExtraKeys}  (not separate CRDs)\n`);

	if (!counts.unique) {
		console.error('Refusing to continue: local Redis reported 0 cached CRDs.');
		process.exit(1);
	}

	if (apply) {
		const sidecar = writeInventorySidecar(counts.firmIds, counts.individualIds);
		console.log(`sidecar: ${SIDECAR_PATH}`);
		console.log(`  counts: people=${sidecar.counts.people} firms=${sidecar.counts.firms} unique=${sidecar.counts.unique}  [WROTE]\n`);
	} else {
		console.log(`sidecar: ${SIDECAR_PATH}  [dry run, would write unique=${counts.unique}]\n`);
	}

	if (sidecarOnly) {
		if (!apply) console.log('Dry run. Re-run with --sidecar-only --apply to write the gzip only.');
		return;
	}

	const targets = resolveTargets();
	for (const entry of targets) {
		if (entry.kind === 'upstash' && (!entry.url || !entry.token)) {
			console.warn(`Skipping ${entry.name}: REST url/token not set in the environment.`);
			continue;
		}

		let before = null;
		if (entry.kind === 'local') {
			const redis = new Redis(LOCAL_REDIS_URL, { maxRetriesPerRequest: 2 });
			before = await redis.get(COUNTER_KEY);
			if (apply) await redis.set(COUNTER_KEY, String(counts.unique));
			redis.disconnect();
		} else {
			before = await upstashCommand(entry.url, entry.token, ['GET', COUNTER_KEY]);
			if (apply && confirmed) await upstashCommand(entry.url, entry.token, ['SET', COUNTER_KEY, String(counts.unique)]);
		}

		const wrote = apply && (entry.kind === 'local' || confirmed);
		const suffix = wrote ? 'WROTE' : 'dry run, no write';
		console.log(`${entry.name}: ${COUNTER_KEY} ${before ?? '(unset)'} -> ${counts.unique}  [${suffix}]`);

		if (apply && entry.kind === 'upstash' && !confirmed) {
			console.log('  Add --yes to actually write to production.');
		}
	}

	if (!apply) console.log('\nDry run. Re-run with --apply (and --yes for prod) to write.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
