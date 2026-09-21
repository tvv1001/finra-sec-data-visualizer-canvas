#!/usr/bin/env node
/*
 * build_primed_from_raw.js
 * Build primed-cache bundles (JSON + gzipped binary) from an external raw directory.
 * Usage:
 *   EXTERNAL_RAW_DIR=/path/to/raw node scripts/build_primed_from_raw.js
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = process.cwd();
const EXTERNAL_RAW_DIR = process.env.EXTERNAL_RAW_DIR || '/home/lenny/Dev/webDev/Data-finra-sec/data/raw';
const OUT_DIR = path.join(ROOT, 'data', 'national', 'primed-cache');

function isJsonFile(name) {
	return name && name.toLowerCase().endsWith('.json');
}

function isEmptyHitsObj(obj) {
	try {
		if (!obj || !obj.hits) return false;
		const h = obj.hits;
		const total = h.total;
		const totalVal = typeof total === 'number' ? total : total && total.value;
		return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
	} catch (e) {
		return false;
	}
}

async function collectJsonFiles(dir) {
	const map = new Map();
	async function walk(d) {
		const ents = await fs.readdir(d, { withFileTypes: true });
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				await walk(p);
				continue;
			}
			if (!e.isFile()) continue;
			if (!isJsonFile(e.name)) continue;
			map.set(p, e.name);
		}
	}
	await walk(dir);
	return map; // Map<fullpath, filename>
}

function bucketForKey(key) {
	if (key.startsWith('finra:individual:')) return 'finra-individual';
	if (key.startsWith('sec:individual:')) return 'sec-individual';
	if (key.startsWith('finra:firm:')) return 'finra-firm';
	if (key.startsWith('sec:firm:')) return 'sec-firm';
	// fallback by filename patterns
	if (key.startsWith('api.brokercheck.finra.org')) {
		if (key.includes('_firm_')) return 'finra-firm';
		return 'finra-individual';
	}
	if (key.startsWith('api.adviserinfo.sec.gov')) {
		if (key.includes('_firm_')) return 'sec-firm';
		return 'sec-individual';
	}
	return null;
}

async function main() {
	try {
		await fs.mkdir(OUT_DIR, { recursive: true });
	} catch {}

	console.log('Collecting JSON files from', EXTERNAL_RAW_DIR);
	const files = await collectJsonFiles(EXTERNAL_RAW_DIR);
	console.log('Found', files.size, 'json files');

	const bundles = {
		'finra-individual': {},
		'sec-individual': {},
		'finra-firm': {},
		'sec-firm': {},
	};
	let processed = 0;
	for (const [full, name] of files) {
		processed++;
		let key = name.replace(/\.json$/i, '');
		// Some files may include path components or be named like "finra-individual-<id>.json"
		// Preserve the original filename-derived key when it matches existing key format.
		// Normalize common legacy names
		if (/^finra-individual-?(\d+)\.json$/i.test(name)) {
			const id = name.replace(/^finra-individual-?(\d+)\.json$/i, '$1');
			key = `finra:individual:${id}:hl=true&includePrevious=true&wt=json`;
		} else if (/^finra:individual:(\d+)$/i.test(key)) {
			key = `${key}:hl=true&includePrevious=true&wt=json`;
		} else if (/^finra:firm:(\d+)$/i.test(key)) {
			key = `${key}:hl=true&wt=json`;
		} else if (/^sec:individual:(\d+)$/i.test(key)) {
			key = `${key}:hl=true&includePrevious=true&wt=json`;
		} else if (/^sec:firm:(\d+)$/i.test(key)) {
			key = `${key}:hl=true&wt=json`;
		}

		try {
			const raw = await fs.readFile(full, 'utf-8');
			if (!raw) continue;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				console.warn('parse error', full, err.message || err);
				continue;
			}

			// Skip empty hits responses
			if (isEmptyHitsObj(parsed)) {
				continue;
			}

			const bucket = bucketForKey(key);
			if (!bucket) continue;
			bundles[bucket][key] = parsed;
		} catch (err) {
			console.warn('read error', full, err.message || err);
		}
	}

	// Write out bundles
	const manifest = {};
	for (const [name, obj] of Object.entries(bundles)) {
		const outJson = path.join(OUT_DIR, `${name}.json`);
		const outBin = path.join(OUT_DIR, `${name}.bin`);
		const count = Object.keys(obj).length;
		manifest[name] = { count };
		try {
			// Merge with existing bundle if present
			let existing = {};
			try {
				const exRaw = await fs.readFile(outJson, 'utf-8');
				existing = JSON.parse(exRaw) || {};
			} catch {}
			const merged = { ...existing, ...obj };
			await fs.writeFile(outJson, JSON.stringify(merged), 'utf-8');

			const mergedBuf = Buffer.from(JSON.stringify(merged), 'utf-8');
			const gz = zlib.gzipSync(mergedBuf);
			await fs.writeFile(outBin, gz);
			manifest[name].written = Object.keys(merged).length;
			manifest[name].bytes = gz.length;
			console.log('wrote bundle', name, 'entries=', Object.keys(merged).length);
		} catch (err) {
			console.warn('failed writing bundle', name, err.message || err);
		}
	}

	const manifestPath = path.join(OUT_DIR, 'manifest.json');
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	console.log('bundles complete. manifest at', manifestPath);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
