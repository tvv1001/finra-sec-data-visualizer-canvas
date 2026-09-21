#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { Redis } = require('@upstash/redis');

const ROOT = process.cwd();
const PRIMED_CACHE_DIR = path.join(ROOT, 'data', 'national', 'primed-cache');
const REDIS_KEY_PREFIX = 'primed:bundle:';
const REDIS_META_SUFFIX = ':meta';
const REDIS_PART_SUFFIX = ':part:';
const MAX_CHUNK_CHARS = Number(process.env.PRIMED_REDIS_CHUNK_CHARS || 700_000);

function isValidUpstashUrl(value) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function shouldUploadBundleName(bundleName) {
	return bundleName && !/(?:^|[-_.])(manifest|index|meta)$/i.test(bundleName);
}

function getBundleKey(bundleName) {
	return `${REDIS_KEY_PREFIX}${bundleName}`;
}

function getBundleMetaKey(bundleName) {
	return `${getBundleKey(bundleName)}${REDIS_META_SUFFIX}`;
}

function getBundlePartKey(bundleName, index) {
	return `${getBundleKey(bundleName)}${REDIS_PART_SUFFIX}${index}`;
}

function splitIntoChunks(value, maxChunkChars) {
	const chunks = [];
	for (let index = 0; index < value.length; index += maxChunkChars) {
		chunks.push(value.slice(index, index + maxChunkChars));
	}
	return chunks;
}

async function uploadBundle(redis, bundleName, payloadBase64) {
	const bundleKey = getBundleKey(bundleName);
	const metaKey = getBundleMetaKey(bundleName);
	const chunks = splitIntoChunks(payloadBase64, MAX_CHUNK_CHARS);

	if (chunks.length <= 1) {
		await redis.set(bundleKey, payloadBase64);
		await redis.del(metaKey).catch(() => 0);
		console.log(`Uploaded ${bundleName} as single payload -> ${bundleKey}`);
		return;
	}

	await redis.del(bundleKey).catch(() => 0);
	for (let index = 0; index < chunks.length; index += 1) {
		await redis.set(getBundlePartKey(bundleName, index), chunks[index]);
	}
	await redis.set(
		metaKey,
		JSON.stringify({
			encoding: 'base64-gzip',
			chunked: true,
			chunks: chunks.length,
			chunkChars: MAX_CHUNK_CHARS,
			updatedAt: new Date().toISOString(),
		}),
	);
	console.log(`Uploaded ${bundleName} in ${chunks.length} chunk(s) -> ${metaKey}`);
}

async function main() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
		process.exit(1);
	}
	if (!isValidUpstashUrl(url)) {
		console.error(`Invalid UPSTASH_REDIS_REST_URL: ${JSON.stringify(url)}. It must be a real Upstash HTTPS URL like https://<id>.upstash.io`);
		process.exit(1);
	}

	const redis = new Redis({ url, token });
	const entries = await fs.readdir(PRIMED_CACHE_DIR).catch(() => []);
	const bundleNames = entries
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.replace(/\.json$/i, ''))
		.filter(shouldUploadBundleName)
		.sort((a, b) => a.localeCompare(b));

	let uploaded = 0;
	for (const bundleName of bundleNames) {
		const binPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.bin`);
		const jsonPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.json`);
		if (await exists(binPath)) {
			const data = await fs.readFile(binPath);
			await uploadBundle(redis, bundleName, data.toString('base64'));
			uploaded += 1;
			continue;
		}
		if (await exists(jsonPath)) {
			const jsonText = await fs.readFile(jsonPath, 'utf-8');
			const zlib = require('node:zlib');
			const gz = zlib.gzipSync(Buffer.from(jsonText, 'utf-8'));
			await uploadBundle(redis, bundleName, gz.toString('base64'));
			uploaded += 1;
			continue;
		}
		console.warn(`Missing bundle for ${bundleName}: neither ${binPath} nor ${jsonPath} found`);
	}

	console.log(`Deployed ${uploaded} primed bundle(s) to Redis`);
}

main().catch((error) => {
	console.error('deploy_primed_cache_to_redis failed:', error);
	process.exit(1);
});
