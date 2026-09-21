import type { Redis } from '@upstash/redis';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { getRedisClientInstance } from '@/lib/redisClient';
import { setStringIfValid } from '@/lib/redisCache';
import { canCallExternalApis } from '@/lib/externalApiGate';
import { isRedisCacheOnly } from '@/lib/redisAvailability';

type MemStore = Map<string, { value: unknown; expiresAt: number }>;
type PrimedBundle = Record<string, unknown>;
type PrimedBundleName = 'finra-individual' | 'sec-individual' | 'finra-firm' | 'sec-firm';

let upstash: Redis | null = null;
let memStore: MemStore | null = null;
const primedBundleCache = new Map<PrimedBundleName, PrimedBundle | null>();

const EXTERNAL_API_MIN_INTERVAL_MS = Number(process.env.EXTERNAL_API_MIN_INTERVAL_MS || 1000);
const EXTERNAL_API_FAILURE_COOLDOWN_MS = Number(process.env.EXTERNAL_API_FAILURE_COOLDOWN_MS || 60_000);

const primedBundleBinFiles: Record<PrimedBundleName, string> = {
	'finra-individual': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'finra-individual.bin'),
	'sec-individual': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'sec-individual.bin'),
	'finra-firm': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'finra-firm.bin'),
	'sec-firm': path.resolve(process.cwd(), 'data', 'national', 'primed-cache', 'sec-firm.bin'),
};

const lastExternalFetch = new Map<string, number>();
const lastExternalFailure = new Map<string, number>();

// Strip any query-string suffix from finra/sec record keys so Redis keys are
// always plain "source:type:id" regardless of how they were originally requested.
function normalizeKey(key: string): string {
	const match = /^(finra|sec):(individual|firm):(\d{1,10}|8-\d+)(?::.+)?$/i.exec(key);
	if (match) return `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}`;
	return key;
}

import { decompressPayload } from '@/lib/redisCache';

/** Safely parse a Redis value — Upstash auto-deserialises JSON so the value may
 *  already be a plain object rather than a JSON string. */
function parseRedisValue<T>(raw: unknown): T | null {
	if (raw == null) return null;
	if (typeof raw === 'string') {
		const decompressed = decompressPayload(raw);
		try {
			return JSON.parse(decompressed) as T;
		} catch {
			return null;
		}
	}
	return raw as T;
}

function getUpstash(): Redis | null {
	if (isRedisCacheOnly()) return null;
	if (upstash !== null) return upstash;
	// prefer MIRROR env var first, fall back to legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) upstash = getRedisClientInstance({ url, token });
	return upstash;
}

function getPrimedRedisKey(name: PrimedBundleName): string {
	return `primed:bundle:${name}`;
}

function getPrimedRedisMetaKey(name: PrimedBundleName): string {
	return `${getPrimedRedisKey(name)}:meta`;
}

function getPrimedRedisPartKey(name: PrimedBundleName, index: number): string {
	return `${getPrimedRedisKey(name)}:part:${index}`;
}

function getMem(): MemStore {
	if (!memStore) memStore = new Map();
	return memStore;
}

function normalizePrimedBundle(parsed: PrimedBundle): PrimedBundle {
	const normalized: PrimedBundle = {};
	for (const bundleKey of Object.keys(parsed)) {
		try {
			normalized[normalizeKey(bundleKey)] = parsed[bundleKey];
		} catch {
			normalized[bundleKey] = parsed[bundleKey];
		}
	}
	return normalized;
}

async function decodePrimedBundlePayload(raw: string): Promise<PrimedBundle | null> {
	try {
		const json = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
		return normalizePrimedBundle(JSON.parse(json) as PrimedBundle);
	} catch {
		return null;
	}
}

async function getPrimedBundleFromRedis(name: PrimedBundleName): Promise<PrimedBundle | null> {
	const redis = getUpstash();
	if (!redis) return null;
	try {
		const raw = await redis.get<string>(getPrimedRedisKey(name));
		if (raw) {
			const decoded = await decodePrimedBundlePayload(raw);
			if (decoded) return decoded;
		}

		const rawMeta = await redis.get<string>(getPrimedRedisMetaKey(name));
		if (!rawMeta) return null;
		const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
		const chunkCount = Number(meta?.chunks || 0);
		if (!meta?.chunked || !Number.isFinite(chunkCount) || chunkCount <= 0) return null;

		const partPromises: Promise<string | null>[] = [];
		for (let index = 0; index < chunkCount; index += 1) {
			partPromises.push(redis.get<string>(getPrimedRedisPartKey(name, index)));
		}
		const parts = await Promise.all(partPromises);
		if (parts.some((part) => part === null)) return null;

		return decodePrimedBundlePayload(parts.filter((p): p is string => p !== null).join(''));
	} catch {
		return null;
	}
}

async function loadPrimedBundle(name: PrimedBundleName): Promise<PrimedBundle | null> {
	if (primedBundleCache.has(name)) return primedBundleCache.get(name) ?? null;

	const binPath = primedBundleBinFiles[name];
	try {
		const rawBin = await readFile(binPath);
		const decoded = await decodePrimedBundlePayload(rawBin.toString('base64'));
		if (decoded) {
			primedBundleCache.set(name, decoded);
			return decoded;
		}
	} catch {
		// fall through
	}

	const redisBundle = await getPrimedBundleFromRedis(name);
	primedBundleCache.set(name, redisBundle);
	return redisBundle;
}

function resolvePrimedBundleName(key: string): PrimedBundleName | null {
	if (/^finra:individual:\d+$/.test(key)) return 'finra-individual';
	if (/^sec:individual:\d+$/.test(key)) return 'sec-individual';
	if (/^finra:firm:\d+$/.test(key)) return 'finra-firm';
	if (/^sec:firm:\d+$/.test(key)) return 'sec-firm';
	return null;
}

async function getPrimedCacheValue<T>(key: string): Promise<T | null> {
	if (process.env.VERCEL === '1') return null;
	const normalizedKey = normalizeKey(key);
	const bundleName = resolvePrimedBundleName(normalizedKey);
	if (!bundleName) return null;
	const bundle = await loadPrimedBundle(bundleName);
	if (!bundle) return null;
	if (normalizedKey in bundle) return bundle[normalizedKey] as T;
	if (key in bundle) return bundle[key] as T;
	return null;
}

async function getDiskCacheValue<T>(key: string): Promise<T | null> {
	try {
		const parts = key.split(':');
		if (parts.length < 3) return null;
		const service = parts[0];
		const type = parts[1];
		const id = parts[2];

		if (!/^\d+$/.test(id) && !/^8-\d+$/i.test(id)) return null;

		let folder = '';
		let filePrefix = '';

		if (service === 'finra') {
			folder = 'brokercheck.finra.org';
			filePrefix = 'api.brokercheck.finra.org_search';
		} else if (service === 'sec') {
			folder = 'adviserinfo.sec.gov';
			filePrefix = 'api.adviserinfo.sec.gov_search';
		} else {
			return null;
		}

		const fileName = `${filePrefix}_${type}_${id}.json`;
		const filePath = path.join(process.cwd(), 'data', 'national', folder, fileName);

		try {
			await readFile(filePath);
		} catch {
			return null;
		}

		const content = await readFile(filePath, 'utf-8');
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

function memSet(map: MemStore, key: string, value: unknown, ttlSeconds: number) {
	const expiresAt = Date.now() + ttlSeconds * 1000;
	map.set(key, { value, expiresAt });
	setTimeout(() => {
		const current = map.get(key);
		if (current && current.expiresAt <= Date.now()) map.delete(key);
	}, ttlSeconds * 1000).unref?.();
}

function memGet(map: MemStore, key: string): unknown | null {
	const item = map.get(key);
	if (!item) return null;
	if (item.expiresAt <= Date.now()) {
		map.delete(key);
		return null;
	}
	return item.value;
}

function getExternalService(key: string) {
	if (key.startsWith('finra:')) return 'finra';
	if (key.startsWith('sec:')) return 'sec';
	return '';
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldSkipExternalFetch(service: string) {
	if (!service) return false;
	const now = Date.now();
	const lastFailureAt = lastExternalFailure.get(service) || 0;
	if (now - lastFailureAt < EXTERNAL_API_FAILURE_COOLDOWN_MS) return true;
	if (!canCallExternalApis()) return true;
	return false;
}

/** Delete a key from Redis and in-memory cache so the next cachedFetch goes external. */
export async function evictCacheKey(rawKey: string): Promise<void> {
	const key = normalizeKey(rawKey);
	const redis = getUpstash();
	if (redis) {
		try {
			await redis.del(key);
		} catch {
			// ignore
		}
	}
	getMem().delete(key);
}

export async function waitExternalFetchLimit(service: string) {
	if (!service || !canCallExternalApis()) return;
	const lastFetchAt = lastExternalFetch.get(service) || 0;
	const now = Date.now();
	const elapsed = now - lastFetchAt;
	if (elapsed < EXTERNAL_API_MIN_INTERVAL_MS) {
		const waitTime = EXTERNAL_API_MIN_INTERVAL_MS - elapsed;
		await delay(waitTime);
	}
	lastExternalFetch.set(service, Date.now());
}

export async function cachedFetch<T>(rawKey: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
	const key = normalizeKey(rawKey);
	const mem = getMem();
	const memHit = memGet(mem, key);
	if (memHit !== null) return memHit as T;

	const redis = getUpstash();

	if (redis) {
		try {
			const raw = await redis.get(key);
			if (raw != null) {
				const parsed = parseRedisValue<T>(raw);
				if (parsed != null) {
					// Detect malformed payloads that sometimes get written to Redis
					// (e.g. truncated JSON inside _source.content). If malformed,
					// fall through to external fetcher so we re-populate Redis.
					try {
						const maybeObj: any = parsed as any;
						let malformed = false;
						if (maybeObj && maybeObj.hits && Array.isArray(maybeObj.hits.hits)) {
							for (const h of maybeObj.hits.hits) {
								const content = h?._source?.content;
								if (typeof content === 'string') {
									try {
										JSON.parse(content);
									} catch (e) {
										malformed = true;
										break;
									}
								}
							}
						}
						if (!malformed) {
							memSet(mem, key, parsed, ttlSeconds);
							return parsed;
						}
						// If malformed, proactively remove the bad Redis key so later
						// primed/disk/external fetch paths can provide a clean value.
						try {
							if (redis && typeof redis.del === 'function') await redis.del(key);
						} catch (e) {
							// ignore deletion errors
						}
						// fall through to refresh from external source
					} catch (e) {
						// conservative: if our validation errors, treat as malformed
					}
				}
			}
			const primed = await getPrimedCacheValue<T>(key);
			if (primed != null) {
				memSet(mem, key, primed, ttlSeconds);
				await setStringIfValid(key, JSON.stringify(primed), ttlSeconds);
				return primed;
			}
			const disk = await getDiskCacheValue<T>(key);
			if (disk != null) {
				memSet(mem, key, disk, ttlSeconds);
				await setStringIfValid(key, JSON.stringify(disk), ttlSeconds);
				return disk;
			}
		} catch {
			// fall through to in-memory cache / fetch
		}
	}

	const primed = await getPrimedCacheValue<T>(key);
	if (primed != null) {
		memSet(mem, key, primed, ttlSeconds);
		return primed;
	}

	const diskValue = await getDiskCacheValue<T>(key);
	if (diskValue != null) {
		memSet(mem, key, diskValue, ttlSeconds);
		return diskValue;
	}

	// When Redis is unusable, stay on caches — do not open external FINRA/SEC floodgates.
	if (isRedisCacheOnly()) {
		return undefined as unknown as T;
	}

	const service = getExternalService(key);
	if (shouldSkipExternalFetch(service)) {
		return undefined as unknown as T;
	}

	const domain = service === 'finra' ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov';
	const parts = key.split(':');
	const crd = parts[2] || '';
	console.log(`[External API Access] Time: ${new Date().toISOString()} | Accessing external API | Domain: ${domain} | CRDs: [${crd}] | Count: 1`);

	await waitExternalFetchLimit(service);

	try {
		const value = await fetcher();
		if (service) lastExternalFetch.set(service, Date.now());
		if (value !== undefined) {
			memSet(mem, key, value, ttlSeconds);
			const newJson = JSON.stringify(value);

			// Always cache to disk to survive Redis quota limits
			try {
				const fs = require('fs');
				const path = require('path');
				const keyParts = key.split(':');
				if (keyParts.length >= 3) {
					const s = keyParts[0];
					const t = keyParts[1];
					const i = keyParts[2];
					let folder = '';
					let filePrefix = '';
					if (s === 'finra') {
						folder = 'brokercheck.finra.org';
						filePrefix = 'api.brokercheck.finra.org_search';
					} else if (s === 'sec') {
						folder = 'adviserinfo.sec.gov';
						filePrefix = 'api.adviserinfo.sec.gov_search';
					}
					if (folder) {
						const fileName = `${filePrefix}_${t}_${i}.json`;
						const filePath = path.join(process.cwd(), 'data', 'national', folder, fileName);
						fs.mkdirSync(path.dirname(filePath), { recursive: true });
						fs.writeFileSync(filePath, newJson, 'utf-8');
					}
				}
			} catch (e) {}

			if (redis) {
				try {
					// Enforce no TTL
					await setStringIfValid(key, newJson, null);
					console.log(`[External API Access Success] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs added: [${crd}] | Added count: 1`);
				} catch {
					console.log(`[External API Access Success] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs added: [${crd}] | Added count: 1 (memory only)`);
				}
			} else {
				console.log(`[External API Access Success] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs added: [${crd}] | Added count: 1 (memory only)`);
			}
		} else {
			console.log(`[External API Access Warning] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs added: [] | Added count: 0 (undefined response)`);
		}
		return value;
	} catch (error) {
		if (service) lastExternalFailure.set(service, Date.now());
		console.log(`[External API Access Failure] Time: ${new Date().toISOString()} | Domain: ${domain} | CRDs added: [] | Added count: 0`);
		return undefined as unknown as T;
	}
}
