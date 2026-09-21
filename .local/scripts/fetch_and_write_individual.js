#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

function parseEnvFile(fp) {
	const text = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
	const lines = text.split(/\r?\n/);
	const out = {};
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const idx = line.indexOf('=');
		if (idx === -1) continue;
		const k = line.slice(0, idx).trim();
		const v = line.slice(idx + 1).trim();
		out[k] = v.replace(/^"|"$/g, '');
	}
	return out;
}

async function main() {
	const repoRoot = process.cwd();
	const envPath = path.join(repoRoot, '.env.local');
	const env = { ...process.env, ...parseEnvFile(envPath) };

	const url = env.UPSTASH_REDIS_REST_URL_MIRROR || env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN_MIRROR || env.UPSTASH_REDIS_REST_TOKEN;
	const allowWrites = true;

	if (!url || !token) {
		console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN in environment/.env.local');
		process.exit(2);
	}

	if (!allowWrites) {
		console.error('UPSTASH_ALLOW_WRITES is not set to 1; aborting to avoid accidental writes.');
		process.exit(3);
	}

	const crd = process.argv[2] || '6387765';
	const fetchUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true`;
	console.log('Fetching FINRA payload for CRD', crd, 'from', fetchUrl);
	const res = await axios.get(fetchUrl, { timeout: 20000 });
	if (res.status !== 200) {
		console.error('Upstream fetch failed:', res.status);
		process.exit(4);
	}
	const fresh = res.data;
	const redis = new Redis({ url, token });

	const key = `finra:individual:${crd}`;
	const value = JSON.stringify(fresh);
	console.log('Writing key to Upstash:', key);
	try {
		const r = await redis.set(key, value);
		console.log('Upstash set result:', r);
		// push dashboard alert if available
		try {
			await redis.lpush('dashboard:alerts', JSON.stringify({ at: new Date().toISOString(), id: crd, entity: 'individual', type: 'manual-write', source: 'finra' }));
			await redis.ltrim('dashboard:alerts', 0, 999).catch(() => null);
		} catch (e) {}
		console.log('Done.');
	} catch (e) {
		console.error('Upstash write failed:', e?.message || e);
		process.exit(5);
	}
}

main().catch((e) => {
	console.error('Script failed:', e?.message || e);
	process.exit(1);
});
