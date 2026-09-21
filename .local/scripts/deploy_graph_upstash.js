#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const GRAPH_FILE = path.join(ROOT, 'data', 'national', 'finra-graph.json');
const REDIS_KEY = 'graph:snapshot';
const MANIFEST_KEY = 'graph:manifest';

function getRedis() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in the environment');
	}
	return new Redis({ url, token });
}

async function main() {
	if (!fs.existsSync(GRAPH_FILE)) {
		console.error('Graph file not found:', GRAPH_FILE);
		process.exit(2);
	}
	const buf = fs.readFileSync(GRAPH_FILE);
	const totalBytes = buf.length;
	// choose chunk size safely below Upstash 10MB limit; use 9MB
	const MAX = 9 * 1024 * 1024;
	const parts = [];
	for (let offset = 0; offset < totalBytes; offset += MAX) {
		const end = Math.min(offset + MAX, totalBytes);
		parts.push(buf.slice(offset, end).toString('utf-8'));
	}

	const redis = getRedis();
	console.log(`Uploading graph as ${parts.length} part(s) to Upstash`);
	// delete any existing part keys and manifest first (best-effort)
	try {
		const existing = await redis.get(MANIFEST_KEY);
		if (existing) {
			const old = JSON.parse(existing);
			for (let i = 0; i < (old.parts || 0); i++) {
				await redis.del(`${REDIS_KEY}:part:${i}`);
			}
			await redis.del(MANIFEST_KEY);
		}
	} catch (e) {
		// ignore
	}

	for (let i = 0; i < parts.length; i++) {
		const key = `${REDIS_KEY}:part:${i}`;
		console.log('setting', key);
		await redis.set(key, parts[i]);
	}

	const manifest = { parts: parts.length, bytes: totalBytes, updatedAt: new Date().toISOString() };
	await redis.set(MANIFEST_KEY, JSON.stringify(manifest));
	console.log('Upload complete. Manifest:', manifest);
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
