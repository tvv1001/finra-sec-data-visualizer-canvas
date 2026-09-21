#!/usr/bin/env node
/*
 * continuous_slow_crawl.js
 * Continuously runs the crawler in small batches until the project contains
 * at least TARGET_NODES unique nodes. Respects polite delays to avoid
 * hammering external APIs. Never removes existing project data; all writes
 * are merges/append-only by design.
 */

const { spawnSync } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const NATIONAL = path.join(DATA_DIR, 'national');
const FINRA_DIR = path.join(NATIONAL, 'brokercheck.finra.org');
const SEC_DIR = path.join(NATIONAL, 'adviserinfo.sec.gov');
const PRIMED_DIR = path.join(NATIONAL, 'primed-cache');

const TARGET_NODES = Number(process.env.TARGET_NODES || process.env.TARGET || 50000);
const BATCH_LIMIT = Number(process.env.BATCH_LIMIT || 50);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 130000); // default ~2m10s
const CRAWLER_SCRIPT = path.join(ROOT, 'scripts', 'parallel_crawler.js');
const NODE_BIN = process.env.NODE_BIN || 'node';

function runCrawler(limit) {
	const args = [CRAWLER_SCRIPT, '--limit', String(limit), '--concurrency', '1', '--delay', '2000'];
	console.log('Running crawler:', NODE_BIN, args.join(' '));
	const r = spawnSync(NODE_BIN, args, { stdio: 'inherit' });
	return r.status === 0;
}

async function listJsonFiles(dir) {
	try {
		const names = await fs.readdir(dir);
		return names.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
	} catch {
		return [];
	}
}

async function countUniqueIds() {
	const ids = new Set();

	// gather from FINRA/SEC JSON filenames
	const finraFiles = await listJsonFiles(FINRA_DIR);
	for (const f of finraFiles) {
		const m = /_individual_(\d+)\.json$/.exec(f) || /_firm_(\d+)\.json$/.exec(f);
		if (m) ids.add(m[1]);
		// fallback: try to parse filename tokens
		const m2 = /_(\d+)\.json$/.exec(f);
		if (m2) ids.add(m2[1]);
	}
	const secFiles = await listJsonFiles(SEC_DIR);
	for (const f of secFiles) {
		const m = /individual_(\d+)\.json$/.exec(f) || /firm_(\d+)\.json$/.exec(f);
		if (m) ids.add(m[1]);
		const m2 = /_(\d+)\.json$/.exec(f);
		if (m2) ids.add(m2[1]);
	}

	// include primed bundle keys (extract ids from keys like "finra:individual:12345:...")
	try {
		const files = await fs.readdir(PRIMED_DIR);
		for (const fn of files) {
			if (!fn.endsWith('.bin') && !fn.endsWith('.json')) continue;
			const p = path.join(PRIMED_DIR, fn);
			try {
				const buf = await fs.readFile(p);
				let txt = null;
				if (fn.endsWith('.bin')) {
					const decompressed = zlib.gunzipSync(buf);
					txt = decompressed.toString('utf-8');
				} else {
					txt = buf.toString('utf-8');
				}
				if (!txt) continue;
				const obj = JSON.parse(txt);
				for (const k of Object.keys(obj)) {
					const parts = k.split(':');
					if (parts.length >= 3) {
						const id = parts[2];
						if (/^\d+$/.test(id)) ids.add(id);
					}
				}
			} catch (e) {
				// ignore parse errors
			}
		}
	} catch (e) {
		// no primed dir
	}

	return ids.size;
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

(async function main() {
	console.log(`continuous_slow_crawl: target=${TARGET_NODES}, batch=${BATCH_LIMIT}, intervalMs=${INTERVAL_MS}`);
	if (!fsSync.existsSync(CRAWLER_SCRIPT)) {
		console.error('crawler script not found:', CRAWLER_SCRIPT);
		process.exit(2);
	}

	while (true) {
		try {
			const count = await countUniqueIds();
			console.log(`current unique ids in project: ${count}`);
			if (count >= TARGET_NODES) {
				console.log(`Reached target ${TARGET_NODES} (current ${count}). Exiting.`);
				process.exit(0);
			}

			// run a small batch crawl
			const ok = runCrawler(BATCH_LIMIT);
			if (!ok) console.warn('crawler process exited with non-zero code; continuing');

			// after each batch, wait a polite interval before next batch
			console.log(`Sleeping ${INTERVAL_MS}ms before next batch...`);
			await sleep(INTERVAL_MS);
		} catch (e) {
			console.error('continuous crawler error', e);
			await sleep(Math.max(60000, INTERVAL_MS));
		}
	}
})();
