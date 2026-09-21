#!/usr/bin/env node
/**
 * Quota-friendly delta push: local Redis → Upstash DB1+DB2 via batched MSET.
 *
 * Prefer this over push_all_to_prod.mjs when only new/changed keys need syncing.
 *
 *   npx tsx --env-file=.env.local .local/scripts/push_delta_to_prod.mjs \
 *     --match='firm-connections:firm:*' --match='sec:firm:*' --match='sec:individual:*'
 *
 *   npx tsx --env-file=.env.local .local/scripts/push_delta_to_prod.mjs \
 *     --keys-file=.local/tmp/keys_to_push.txt --batch=50 --sleep=200
 *
 *   npx tsx --env-file=.env.local .local/scripts/push_delta_to_prod.mjs \
 *     --since-file=.local/tmp/last_prod_push_keys.txt --match='*'
 *
 * Flags:
 *   --match=PATTERN     SCAN match (repeatable). Default: firm-connections:firm:*
 *   --keys-file=PATH    Explicit key list (one per line)
 *   --batch=N           MSET batch size (default 50)
 *   --sleep=MS          Delay between Upstash batches (default 150)
 *   --dry-run           List keys only
 *   --skip-exists       Skip keys that already exist on DB1 (costs 1 EXISTS each)
 *   --db=both|1|2       Target (default both)
 */
import fs from 'node:fs';
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';

const argv = process.argv.slice(2);
function flag(name, fallback = '') {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(`--${name}=`.length) : fallback;
}
function flags(name) {
	return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(`--${name}=`.length));
}

const BATCH = Math.max(1, Number(flag('batch', '50')) || 50);
const SLEEP_MS = Math.max(0, Number(flag('sleep', '150')) || 150);
const DRY = argv.includes('--dry-run');
const SKIP_EXISTS = argv.includes('--skip-exists');
const DB = flag('db', 'both');
const KEYS_FILE = flag('keys-file');
const MATCHES = flags('match');
const patterns = MATCHES.length ? MATCHES : ['firm-connections:firm:*'];

const local = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
const db1 =
	DB === '2'
		? null
		: new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const db2 =
	DB === '1'
		? null
		: new UpstashRedis({
				url: process.env.UPSTASH_REDIS_REST_URL_MIRROR,
				token: process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR,
			});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanLocal(match) {
	const keys = [];
	let cursor = '0';
	do {
		const [next, batch] = await local.scan(cursor, 'MATCH', match, 'COUNT', 500);
		cursor = next;
		keys.push(...batch);
	} while (cursor !== '0');
	return keys;
}

async function main() {
	let keys = [];
	if (KEYS_FILE) {
		keys = fs
			.readFileSync(KEYS_FILE, 'utf8')
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		for (const match of patterns) {
			const found = await scanLocal(match);
			console.log(JSON.stringify({ phase: 'scan', match, found: found.length }));
			keys.push(...found);
		}
		keys = [...new Set(keys)];
	}

	// Only string-capable keys (skip zsets/sets — sync those separately)
	const stringKeys = [];
	for (let i = 0; i < keys.length; i += 200) {
		const chunk = keys.slice(i, i + 200);
		const pipe = local.pipeline();
		for (const k of chunk) pipe.type(k);
		const types = await pipe.exec();
		for (let j = 0; j < chunk.length; j++) {
			if (types[j][1] === 'string') stringKeys.push(chunk[j]);
		}
	}

	console.log(JSON.stringify({ phase: 'plan', total: keys.length, stringKeys: stringKeys.length, batch: BATCH, sleepMs: SLEEP_MS, dryRun: DRY }));

	if (DRY) {
		for (const k of stringKeys.slice(0, 50)) console.log(k);
		if (stringKeys.length > 50) console.log(`… +${stringKeys.length - 50} more`);
		await local.quit();
		return;
	}

	let pushed = 0;
	let skipped = 0;
	for (let i = 0; i < stringKeys.length; i += BATCH) {
		const batchKeys = stringKeys.slice(i, i + BATCH);

		let toPush = batchKeys;
		if (SKIP_EXISTS && db1) {
			// One MGET per batch instead of N EXISTS calls (quota-friendly).
			const remote = await db1.mget(...batchKeys);
			toPush = [];
			for (let j = 0; j < batchKeys.length; j++) {
				if (remote[j] === null || remote[j] === undefined) toPush.push(batchKeys[j]);
				else skipped += 1;
			}
			if (!toPush.length) {
				console.log(JSON.stringify({ phase: 'skip-batch', i, skipped, checked: batchKeys.length }));
				await sleep(SLEEP_MS);
				continue;
			}
		}

		const values = await local.mget(...toPush);
		const msetObj = {};
		for (let j = 0; j < toPush.length; j++) {
			if (values[j] !== null && values[j] !== undefined) msetObj[toPush[j]] = values[j];
		}
		const n = Object.keys(msetObj).length;
		if (!n) continue;

		const writes = [];
		if (db1) writes.push(db1.mset(msetObj));
		if (db2) writes.push(db2.mset(msetObj));
		await Promise.all(writes);
		pushed += n;
		console.log(JSON.stringify({ phase: 'pushed', batch: n, pushed, remaining: Math.max(0, stringKeys.length - i - BATCH) }));
		await sleep(SLEEP_MS);
	}

	console.log(JSON.stringify({ ok: true, phase: 'done', pushed, skipped, stringKeys: stringKeys.length }));
	await local.quit();
}

main().catch(async (e) => {
	console.error(e);
	try {
		await local.quit();
	} catch {}
	process.exit(1);
});
