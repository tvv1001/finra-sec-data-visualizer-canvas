#!/usr/bin/env node
// Poll monitor script: only poll monitored CRDs that haven't been checked in the
// last 24 hours. Batch Redis reads and update per-CRD last-checked keys after
// hitting the local detail endpoint so subsequent runs skip recently-checked items.

const http = require('http');
const { getRedisClientInstance } = require('../src/lib/redisClient');

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const BATCH_SIZE = 200; // batch size for mget
const CONCURRENCY = 8; // parallel HTTP fetches

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchUrl(path) {
	return new Promise((resolve) => {
		const opts = { hostname: '127.0.0.1', port: process.env.PORT || 4444, path, method: 'GET', headers: { Accept: 'application/json' } };
		const req = http.request(opts, (res) => {
			// consume and ignore body
			res.on('data', () => {});
			res.on('end', () => resolve({ ok: true, status: res.statusCode }));
		});
		req.on('error', (err) => {
			resolve({ ok: false, error: err.message });
		});
		req.setTimeout(15000, () => {
			req.abort();
			resolve({ ok: false, error: 'timeout' });
		});
		req.end();
	});
}

async function run() {
	const redis = getRedisClientInstance({ url: process.env.UPSTASH_REDIS_REST_URL || '', token: process.env.UPSTASH_REDIS_REST_TOKEN || '' });
	const sets = ['dashboard:monitored-crds:individual', 'dashboard:monitored-crds:firm'];
	for (const setKey of sets) {
		try {
			const members = await redis.smembers(setKey).catch(() => []);
			if (!members || !members.length) continue;
			console.log(`monitor: ${members.length} entries in ${setKey}`);

			// process in batches to avoid giant mget calls
			for (let i = 0; i < members.length; i += BATCH_SIZE) {
				const batch = members.slice(i, i + BATCH_SIZE);
				const lastKeys = batch.map((id) => `dashboard:crd-lastchecked:${setKey.endsWith(':firm') ? 'firm' : 'individual'}:${id}`);
				const lastVals = lastKeys.length ? await redis.mget(...lastKeys).catch(() => []) : [];
				const now = Date.now();
				const toPoll = [];
				for (let j = 0; j < batch.length; j++) {
					const id = batch[j];
					const raw = lastVals[j];
					let last = 0;
					try {
						last = raw ? Number(JSON.parse(raw)) || 0 : 0;
					} catch {
						last = Number(raw) || 0;
					}
					if (!last || now - last > ONE_DAY_MS) toPoll.push(id);
				}

				if (!toPoll.length) continue;
				console.log(`monitor: polling ${toPoll.length} items from ${setKey} (batch ${i / BATCH_SIZE + 1})`);

				// fetch with limited concurrency
				const tasks = [...toPoll];
				const promises = [];
				for (let w = 0; w < CONCURRENCY; w++) {
					promises.push(
						(async () => {
							while (tasks.length) {
								const id = tasks.shift();
								const isFirm = setKey.endsWith(':firm');
								const path =
									isFirm ? `/api/finra/firm/${encodeURIComponent(id)}?merged=1&forceRefresh=0` : `/api/finra/individual/${encodeURIComponent(id)}?merged=1&forceRefresh=0`;
								try {
									await fetchUrl(path);
								} catch (e) {
									// ignore per-item errors
								}
								// update last-checked timestamp (best-effort)
								const lastKey = `dashboard:crd-lastchecked:${isFirm ? 'firm' : 'individual'}:${id}`;
								try {
									await redis.set(lastKey, JSON.stringify(Date.now())).catch(() => null);
								} catch {
									/* ignore */
								}
								// small pause to avoid hammering local server in tight loops
								await sleep(50);
							}
						})(),
					);
				}
				await Promise.all(promises);
			}
		} catch (e) {
			console.warn('monitor error for set', setKey, e?.message || e);
		}
	}
	process.exit(0);
}

run().catch((e) => {
	console.error(e);
	process.exit(2);
});
