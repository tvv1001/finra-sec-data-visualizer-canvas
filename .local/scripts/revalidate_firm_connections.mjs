#!/usr/bin/env node
/*
 * revalidate_firm_connections.mjs
 *
 * Long-running, respectful (sequential, backoff-aware) background job that:
 *  1. Reads every firm's broker-id-mirror connection lists (finra/sec, current/previous)
 *     directly from local Redis.
 *  2. Prioritizes firms with the LOWEST validated % first (worst data quality first),
 *     then by connection count descending within each tier.
 *  3. For each connection CRD not already validated (no cached finra:individual:<crd>
 *     or sec:individual:<crd> record), calls the local app's own
 *     /api/finra/individual/<crd>?merged=1&forceRefresh=1 route, which performs the
 *     external FINRA/SEC fetch, "poor payload" detection/eviction, and Redis write —
 *     reusing all existing validation logic rather than duplicating it here.
 *  4. Honors 429 responses: reads `retry-after` header when present, otherwise backs off
 *     with 2-4 minute randomized pause + exponential backoff w/ 0.6x-1.4x jitter, per repo policy.
 *  5. Strictly sequential (concurrency=1) across individual fetches, per repo crawling policy.
 *  6. Writes progress + a running log of "corrections" (CRDs found NOT to reference the
 *     firm after validation) to ./data/revalidation-state.json and ./data/revalidation-log.jsonl
 *     so the process is resumable and auditable.
 *  7. After finishing all individuals for a firm, re-fetches that firm's connections via
 *     /api/finra/firm/<firmId>/connections?forceRefresh=1 so the corrected mirror gets
 *     persisted (filterOutDisprovenBrokerMirrorEntries + persistBrokerIdLists already
 *     handle dropping disproven CRDs and re-writing the validated mirror keys).
 *
 * Usage: node scripts/revalidate_firm_connections.mjs [--base http://localhost:4444] [--max-firms N]
 */
import Redis from 'ioredis';
import zlib from 'zlib';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, 'data', 'revalidation-state.json');
const LOG_FILE = path.join(ROOT, 'data', 'revalidation-log.jsonl');

const args = process.argv.slice(2);
function argVal(name, def) {
	const i = args.indexOf(`--${name}`);
	if (i >= 0 && args[i + 1]) return args[i + 1];
	return def;
}
const BASE = argVal('base', 'http://localhost:4444');
const MAX_FIRMS = Number(argVal('max-firms', Infinity));
const DELAY_MS = Number(argVal('delay', 1500));

const redis = new Redis('redis://127.0.0.1:6379');

function decompress(v) {
	if (typeof v === 'string' && v.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(v.slice(3), 'base64')).toString('utf-8');
		} catch {
			return v;
		}
	}
	return v;
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function loadState() {
	try {
		const raw = await fs.readFile(STATE_FILE, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { completedFirms: {}, validatedCrds: {}, disprovenCrds: {}, startedAt: new Date().toISOString() };
	}
}

async function saveState(state) {
	await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
	await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function appendLog(entry) {
	await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
	await fs.appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

async function getFirmMirrorCrds(firmId) {
	const raw = await redis.get(`firm-connections:firm:${firmId}`).catch(() => null);
	const all = new Set();
	if (!raw) return [];
	try {
		const text = typeof raw === 'string' && raw.startsWith('br:') ? decompress(raw) : raw;
		const parsed = typeof text === 'string' ? JSON.parse(text) : text;
		for (const entry of [...(parsed?.currentConnections || []), ...(parsed?.previousConnections || [])]) {
			const id = String(entry?.individualId || entry?.crd || entry || '').trim();
			if (/^\d{1,10}$/.test(id)) all.add(id);
		}
	} catch {}
	return Array.from(all);
}

async function listAllFirmIds() {
	const keys = await redis.keys('firm-connections:firm:*');
	const ids = new Set();
	for (const key of keys) {
		const match = key.match(/^firm-connections:firm:(\d+)$/);
		if (match) ids.add(match[1]);
	}
	return Array.from(ids);
}

// Backoff-aware fetch of one individual via the local app route (which does the real
// external FINRA/SEC fetch + Redis write + poor-payload eviction/refetch).
async function revalidateIndividual(crd) {
	const url = `${BASE}/api/finra/individual/${encodeURIComponent(crd)}?merged=1&forceRefresh=1&write=1`;
	for (let attempt = 0; attempt < 6; attempt++) {
		let res;
		try {
			res = await fetch(url, { headers: { Accept: 'application/json' } });
		} catch (err) {
			await sleep(5000);
			continue;
		}
		if (res.status === 429) {
			const retryAfterHeader = res.headers.get('retry-after');
			let waitMs;
			if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) {
				waitMs = Number(retryAfterHeader) * 1000 + 2000;
			} else {
				const baseMs = (2 + Math.random() * 2) * 60 * 1000; // 2-4 min
				const jitter = 0.6 + Math.random() * 0.8; // 0.6x-1.4x
				waitMs = baseMs * jitter * Math.pow(1.5, attempt);
			}
			console.log(`[429] backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}) for crd ${crd}`);
			await sleep(waitMs);
			continue;
		}
		if (!res.ok) {
			return { ok: false, status: res.status };
		}
		try {
			const json = await res.json();
			return { ok: true, json };
		} catch {
			return { ok: false, status: 'parse-error' };
		}
	}
	return { ok: false, status: 'max-retries' };
}

function individualReferencesFirm(json, firmId) {
	if (!json || json.found === false) return null; // unknown/unverifiable
	const employmentArrays = [
		json?.currentEmployments,
		json?.previousEmployments,
		json?.currentIAEmployments,
		json?.previousIAEmployments,
		json?.finra?.currentEmployments,
		json?.finra?.previousEmployments,
		json?.sec?.currentIAEmployments,
		json?.sec?.previousIAEmployments,
	].filter(Array.isArray);
	for (const arr of employmentArrays) {
		for (const e of arr) {
			const fid = e?.firmId ?? e?.firm_id ?? e?.firmID;
			if (fid != null && String(fid) === String(firmId)) return true;
		}
	}
	return employmentArrays.length ? false : null;
}

async function revalidateFirmConnections(firmId) {
	// Trigger the app's own connections endpoint with forceRefresh so any now-disproven
	// entries get filtered and the mirror keys get corrected/re-persisted.
	try {
		const res = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}/connections?forceRefresh=1`);
		if (res.ok) return true;
	} catch {}
	return false;
}

async function main() {
	console.log(`revalidate_firm_connections starting. base=${BASE} delay=${DELAY_MS}ms maxFirms=${MAX_FIRMS}`);
	const state = await loadState();

	const allFirmIds = await listAllFirmIds();
	// Build worst-first priority using a quick per-firm sample validation check (cheap, local only).
	const firmInfo = [];
	for (const firmId of allFirmIds) {
		if (state.completedFirms[firmId]) continue;
		const crds = await getFirmMirrorCrds(firmId);
		if (!crds.length) continue;
		const sample = crds.slice(0, 20);
		let validated = 0;
		for (const crd of sample) {
			const [fi, si] = await Promise.all([redis.exists(`finra:individual:${crd}`), redis.exists(`sec:individual:${crd}`)]);
			if (fi || si) validated++;
		}
		const pct = sample.length ? validated / sample.length : 0;
		firmInfo.push({ firmId, total: crds.length, pct });
	}
	firmInfo.sort((a, b) => a.pct - b.pct || b.total - a.total);

	console.log(`Found ${firmInfo.length} firms remaining to process (worst-first).`);

	let firmsProcessed = 0;
	for (const { firmId, total } of firmInfo) {
		if (firmsProcessed >= MAX_FIRMS) break;
		console.log(`\n=== Firm ${firmId} (${total} connections) — starting revalidation ===`);
		const crds = await getFirmMirrorCrds(firmId);
		let checkedCount = 0;
		let disprovenCount = 0;
		let confirmedCount = 0;
		let unknownCount = 0;

		for (const crd of crds) {
			// Skip if already validated in a prior run (has a cached individual record already).
			const alreadyCached = await Promise.all([redis.exists(`finra:individual:${crd}`), redis.exists(`sec:individual:${crd}`)]);
			if (alreadyCached[0] || alreadyCached[1]) {
				// Still verify it actually references this firm (cheap local check via merged route, no forceRefresh).
				try {
					const res = await fetch(`${BASE}/api/finra/individual/${encodeURIComponent(crd)}?merged=1`);
					if (res.ok) {
						const json = await res.json();
						const refs = individualReferencesFirm(json, firmId);
						if (refs === false) {
							disprovenCount++;
							state.disprovenCrds[crd] = firmId;
							await appendLog({ type: 'disproven-cached', firmId, crd });
						} else if (refs === true) {
							confirmedCount++;
						} else {
							unknownCount++;
						}
					}
				} catch {}
				continue;
			}

			const result = await revalidateIndividual(crd);
			checkedCount++;
			if (result.ok) {
				const refs = individualReferencesFirm(result.json, firmId);
				if (refs === true) {
					confirmedCount++;
					state.validatedCrds[crd] = true;
				} else if (refs === false) {
					disprovenCount++;
					state.disprovenCrds[crd] = firmId;
					await appendLog({ type: 'disproven-fetched', firmId, crd });
				} else {
					unknownCount++; // found:false — genuinely uncached upstream, or still rate-limited
				}
			} else {
				unknownCount++;
			}

			if (checkedCount % 25 === 0) {
				console.log(`  firm ${firmId}: ${checkedCount}/${crds.length} checked (confirmed=${confirmedCount} disproven=${disprovenCount} unknown=${unknownCount})`);
				await saveState(state);
			}
			await sleep(DELAY_MS);
		}

		// Re-fetch firm connections so disproven CRDs get filtered out and the mirror gets corrected.
		await revalidateFirmConnections(firmId);

		state.completedFirms[firmId] = {
			total,
			confirmedCount,
			disprovenCount,
			unknownCount,
			completedAt: new Date().toISOString(),
		};
		await saveState(state);
		await appendLog({ type: 'firm-complete', firmId, total, confirmedCount, disprovenCount, unknownCount });
		firmsProcessed++;
		console.log(`=== Firm ${firmId} done: confirmed=${confirmedCount} disproven=${disprovenCount} unknown=${unknownCount} ===`);
	}

	console.log('\nAll firms processed (or max-firms limit reached).');
	process.exit(0);
}

main().catch((err) => {
	console.error('Fatal error in revalidate_firm_connections:', err);
	process.exit(1);
});
