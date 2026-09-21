import type { Redis } from '@upstash/redis';
import { setStringIfValid, decompressPayload } from '@/lib/redisCache';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRedisClientInstance } from '@/lib/redisClient';
import { canCallExternalApis } from '@/lib/externalApiGate';

/** True when Redis already has a usable payload — skip external rehydration. */
function isUsableLocalPayload(raw: unknown): boolean {
	if (raw == null) return false;
	try {
		const text =
			typeof raw === 'string' ? decompressPayload(raw)
			: typeof raw === 'object' ? JSON.stringify(raw)
			: String(raw);
		if (!text || text.includes('"hits":{"total":0')) return false;
		return text.includes('"hits"') || text.includes('_source');
	} catch {
		return false;
	}
}

interface QueueItem {
	type: 'individual' | 'firm';
	id: string;
}

const hydrationQueue: QueueItem[] = [];
let isProcessing = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedRedisClient: Redis | null = null;
function getRedisClient() {
	if (cachedRedisClient) return cachedRedisClient;
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) {
		cachedRedisClient = getRedisClientInstance({ url, token });
	}
	return cachedRedisClient;
}

async function fetchAndSave(source: 'finra' | 'sec', type: 'individual' | 'firm', id: string) {
	const isFinra = source === 'finra';
	const isIndividual = type === 'individual';

	const url =
		isFinra && isIndividual ? `https://api.brokercheck.finra.org/search/individual/${id}?hl=true&includePrevious=true&wt=json`
		: isFinra && !isIndividual ? `https://api.brokercheck.finra.org/search/firm/${id}?hl=true&wt=json`
		: !isFinra && isIndividual ? `https://api.adviserinfo.sec.gov/search/individual/${id}?hl=true&includePrevious=true&wt=json`
		: `https://api.adviserinfo.sec.gov/search/firm/${id}?wt=json`;

	const domain = isFinra ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov';

	console.log(`[Validation Check] Time: ${new Date().toISOString()} | Accessing external API: ${url} | Domain: ${domain} | CRDs: [${id}] | Count: 1`);

	const redisKey = `${source}:${type}:${id}`;
	const redis = getRedisClient();

	// Local-first: only hit the external API when Redis has no usable payload.
	// Cron handles periodic refreshes; UI hydration should not re-download good local data.
	if (redis) {
		try {
			const existing = await redis.get(redisKey).catch(() => null);
			if (isUsableLocalPayload(existing)) {
				console.log(`[Validation Check Skipped] Time: ${new Date().toISOString()} | Found in Redis | Domain: ${domain} | CRDs: [${id}]`);
				return;
			}
		} catch (e) {
			// ignore redis errors and fall through to fetch
		}
	}

	const fetchOptions = {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'Referer': isFinra ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
		},
	};

	const res = await fetch(url, fetchOptions);
	if (!res.ok) {
		console.log(`[Validation Check Failed] Time: ${new Date().toISOString()} | HTTP Error ${res.status} | Domain: ${domain} | CRDs: [${id}]`);
		throw new Error(`HTTP ${res.status} from ${url}`);
	}

	const payload = await res.json();
	if (!payload) {
		console.log(`[Validation Check Failed] Time: ${new Date().toISOString()} | Empty payload | Domain: ${domain} | CRDs: [${id}]`);
		return;
	}

	let cacheStatus = 'no-redis';
	let addedCount = 0;

	if (redis) {
		try {
			const existing = await redis.get(redisKey).catch(() => null);
			const existingJson =
				existing != null ?
					typeof existing === 'string' ?
						existing
					:	JSON.stringify(existing)
				:	null;
			const newJson = JSON.stringify(payload);

			if (existingJson === newJson) {
				cacheStatus = 'matched-cache';
			} else {
				cacheStatus = existingJson ? 'updated-cache' : 'new-cache';
				await setStringIfValid(redisKey, newJson, 60 * 60 * 24);
				addedCount = 1;
			}
		} catch (redisErr: any) {
			cacheStatus = `redis-write-error: ${redisErr.message}`;
		}
	}

	console.log(
		`[Validation Check Success] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs validated: [${id}] | Cache Status: ${cacheStatus} | CRDs added/updated: [${addedCount ? id : ''}] | Count: ${addedCount}`,
	);

	// Save to local cache files if not on Vercel
	if (process.env.VERCEL !== '1') {
		try {
			const cacheDir = isFinra ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
			const cacheFileName = `api.${cacheDir}_search_${type}_${id}.json`;

			const nationalFile = path.join(process.cwd(), 'data', 'national', cacheDir, cacheFileName);
			const rawFile = path.join(process.cwd(), 'data', 'raw', cacheDir, cacheFileName);

			for (const f of [nationalFile, rawFile]) {
				await fs.mkdir(path.dirname(f), { recursive: true });
				await fs.writeFile(f, JSON.stringify(payload, null, 2), 'utf8');
			}
		} catch (err: any) {
			console.warn(`[Validation Check File Write Warning] ${err.message}`);
		}
	}
}

async function processQueue() {
	if (isProcessing) return;
	isProcessing = true;

	while (hydrationQueue.length > 0) {
		const task = hydrationQueue.shift();
		if (!task) continue;
		if (!canCallExternalApis()) {
			isProcessing = false;
			return;
		}

		try {
			// Meter requests slowly: wait 5 to 10 seconds before hitting external API
			const sleepTime = 5000 + Math.random() * 5000;
			await delay(sleepTime);

			// Check external API for both FINRA and SEC sources to validate
			await Promise.allSettled([fetchAndSave('finra', task.type, task.id), fetchAndSave('sec', task.type, task.id)]);
		} catch (error: any) {
			console.error(`[Validation Check Queue Error] ${task.type} ${task.id}:`, error.message);
		}
	}

	isProcessing = false;
}

export function queueHydration(type: 'individual' | 'firm', id: string) {
	if (!canCallExternalApis()) {
		return;
	}

	const alreadyInQueue = hydrationQueue.some((item) => item.type === type && item.id === id);
	if (alreadyInQueue) return;

	hydrationQueue.push({ type, id });
	processQueue().catch((err) => {
		console.error('[Validation Check] processQueue failed:', err);
	});
}
