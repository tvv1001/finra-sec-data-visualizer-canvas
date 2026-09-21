#!/usr/bin/env node
console.error(
	'search:indexes:extensions:* is retired. Search uses gzip sidecars; new CRDs are collected and validated in-app before any Redis write.',
);
process.exit(0);
// Scans all cached FINRA/SEC detail records in Upstash Redis (finra:individual:*,
// finra:firm:*, sec:individual:*, sec:firm:*) and ensures every CRD is represented in
// the local search index. Any CRD missing from the static gzip sidecar (built by
// build_search_indexes.js) and missing from the `search:indexes:extensions:{bucket}`
// Redis hash is added to the extensions hash, so it becomes searchable without needing
// a full sidecar rebuild.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');

function loadEnv(filePath) {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const env = {};
		for (const line of content.split('\n')) {
			const match = line.match(/^([A-Z_]+)\s*=\s*["']?([^"'\n]*)["']?/);
			if (match) env[match[1]] = match[2];
		}
		return env;
	} catch {
		return {};
	}
}

const envVars = {
	...loadEnv(path.join(root, '.env')),
	...loadEnv(path.join(root, '.env.local')),
	...loadEnv(path.join(root, '.env.production')),
};
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || envVars.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || envVars.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
	console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are required.');
	process.exit(1);
}

async function redisCommand(command) {
	const res = await fetch(redisUrl, {
		method: 'POST',
		headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(command),
	});
	if (!res.ok) throw new Error(`Redis command failed (${res.status}): ${await res.text()}`);
	const json = await res.json();
	return json.result;
}

async function scanKeys(pattern) {
	let cursor = '0';
	const keys = [];
	let iterations = 0;
	do {
		const [next, batch] = await redisCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000]);
		cursor = next;
		keys.push(...batch);
		iterations += 1;
	} while (cursor !== '0' && iterations < 5000);
	return keys;
}

function decompressPayload(value) {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf-8');
		} catch {
			return value;
		}
	}
	return value;
}

function getDetailRoot(source, payload) {
	if (!payload || typeof payload !== 'object') return null;
	if (source === 'finra') return payload.content && typeof payload.content === 'object' ? payload.content : null;
	if (source === 'sec') return payload.iacontent && typeof payload.iacontent === 'object' ? payload.iacontent : null;
	return null;
}

function parseDetailFromRawValue(source, raw) {
	if (typeof raw !== 'string' || !raw) return null;
	let text = decompressPayload(raw);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	// Shape A: { hits: { hits: [ { _source: { content: "<json-string>" } } ] } }
	const hit = json?.hits?.hits?.[0]?._source;
	if (hit) {
		const key = source === 'finra' ? 'content' : 'iacontent';
		const rawContent = hit[key];
		if (rawContent != null) {
			const parsedContent = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
			return getDetailRoot(source, { [key]: parsedContent });
		}
	}
	// Shape B: direct detail object already stored under content/iacontent
	const direct = getDetailRoot(source, json);
	if (direct) return direct;
	return null;
}

// Re-use the exact same doc-building logic as build_search_indexes.js so extension docs
// match the static sidecar's shape.
const buildIndexModule = require('./build_search_indexes.js');

async function main() {
	const buckets = [
		{ name: 'finra:individual', source: 'finra', type: 'individual', pattern: 'finra:individual:*' },
		{ name: 'finra:firm', source: 'finra', type: 'firm', pattern: 'finra:firm:*' },
		{ name: 'sec:individual', source: 'sec', type: 'individual', pattern: 'sec:individual:*' },
		{ name: 'sec:firm', source: 'sec', type: 'firm', pattern: 'sec:firm:*' },
	];

	for (const bucket of buckets) {
		console.log(`\n=== ${bucket.name} ===`);
		const keys = await scanKeys(bucket.pattern);
		// Filter out non-detail keys (e.g. ...:summaryHtml:...)
		const detailKeys = keys.filter((key) => /^(finra|sec):(individual|firm):\d+$/.test(key));
		console.log(`Found ${detailKeys.length} cached detail keys (of ${keys.length} matched keys).`);

		const staticIndexPath = path.join(root, 'data', 'national', `search-index.${bucket.source}.${bucket.type}.json`);
		const staticGzPath = `${staticIndexPath}.gz`;
		let staticIds = new Set();
		try {
			let raw;
			if (fs.existsSync(staticIndexPath)) raw = fs.readFileSync(staticIndexPath, 'utf-8');
			else if (fs.existsSync(staticGzPath)) raw = zlib.gunzipSync(fs.readFileSync(staticGzPath)).toString('utf-8');
			if (raw) {
				const parsed = JSON.parse(raw);
				for (const doc of parsed.docs || []) staticIds.add(String(doc.id));
			}
		} catch (err) {
			console.warn(`Could not read static index for ${bucket.name}:`, err?.message || err);
		}

		const extensionsKey = `search:indexes:extensions:${bucket.name}`;
		let existingExtensionIds = new Set();
		try {
			const existingKeys = await redisCommand(['HKEYS', extensionsKey]);
			existingExtensionIds = new Set((existingKeys || []).map(String));
		} catch (err) {
			console.warn(`Could not read existing extensions for ${bucket.name}:`, err?.message || err);
		}

		let added = 0;
		let skippedExisting = 0;
		let skippedNoDetail = 0;
		let failed = 0;

		for (const key of detailKeys) {
			const crd = key.split(':')[2];
			if (staticIds.has(`${bucket.source}:${bucket.type}:${crd}`)) {
				skippedExisting += 1;
				continue;
			}
			if (existingExtensionIds.has(crd)) {
				skippedExisting += 1;
				continue;
			}

			try {
				const raw = await redisCommand(['GET', key]);
				const detail = parseDetailFromRawValue(bucket.source, raw);
				if (!detail) {
					skippedNoDetail += 1;
					continue;
				}
				const doc = bucket.type === 'individual' ? buildIndexModule.buildIndividualDoc(bucket.source, detail) : buildIndexModule.buildFirmDoc(bucket.source, detail);
				if (!doc) {
					skippedNoDetail += 1;
					continue;
				}
				await redisCommand(['HSET', extensionsKey, crd, JSON.stringify(doc)]);
				added += 1;
				if (added % 200 === 0) console.log(`  ...added ${added} so far`);
			} catch (err) {
				failed += 1;
				console.warn(`  Failed to backfill ${key}:`, err?.message || err);
			}
		}

		console.log(`${bucket.name}: added=${added} skippedExisting=${skippedExisting} skippedNoDetail=${skippedNoDetail} failed=${failed}`);
	}
}

main().catch((err) => {
	console.error('backfill_search_extensions failed:', err);
	process.exit(1);
});
