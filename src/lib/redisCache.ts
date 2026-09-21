import type { Redis } from '@upstash/redis';
import Bottleneck from 'bottleneck';
import { getRedisClientInstance } from '@/lib/redisClient';
import { canWriteToRedis, isRedisCacheOnly, noteRedisError } from '@/lib/redisAvailability';
import zlib from 'zlib';

export const DEFAULT_TTL_SECONDS = Number(process.env.REDIS_CACHE_TTL_SECONDS || 86400);

let client: Redis | null = null;
export function getRedisClient(): Redis | null {
	if (isRedisCacheOnly()) return null;
	if (client) return client;
	// prefer MIRROR env var but allow legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	client = getRedisClientInstance({ url, token });
	return client;
}

const limiter = new Bottleneck({ maxConcurrent: 1000, minTime: 1 });

export function isEmptyHitsObj(obj: any): boolean {
	if (!obj || !obj.hits) return false;
	const h = obj.hits;
	const total = h.total;
	const totalVal = typeof total === 'number' ? total : total && total.value;
	return totalVal === 0 && Array.isArray(h.hits) && h.hits.length === 0;
}

function isPlainNumericIdArray(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false;
	try {
		const parsed = JSON.parse(trimmed);
		return (
			Array.isArray(parsed) &&
			parsed.every((item) => {
				if (typeof item === 'number') return Number.isFinite(item);
				if (typeof item === 'string') return /^\d{1,10}$/.test(item.trim());
				return false;
			})
		);
	} catch {
		return false;
	}
}

export function compressPayload(value: string): string {
	if (isPlainNumericIdArray(value)) {
		return value;
	}
	try {
		if (value.length > 512) {
			return 'br:' + zlib.brotliCompressSync(Buffer.from(value), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }).toString('base64');
		}
	} catch {
		// fallback
	}
	return value;
}

export function decompressPayload(value: string): string {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf-8');
		} catch {
			return value;
		}
	}
	return value;
}

export async function setIfValid(
	key: string,
	value: unknown,
	ttlSeconds: number | null = DEFAULT_TTL_SECONDS,
): Promise<'written' | 'skipped-empty' | 'skipped-nonstring' | 'no-client' | 'error'> {
	try {
		if (isEmptyHitsObj(value)) return 'skipped-empty';
		// UPSTASH_ALLOW_WRITES + cache-only gate — avoid accidental / wasted Upstash writes.
		if (!canWriteToRedis()) {
			return 'no-client';
		}
		const redis = getRedisClient();
		if (!redis) return 'no-client';

		await limiter.schedule(async () => {
			const finalValue = compressPayload(JSON.stringify(value));
			if (ttlSeconds) {
				await redis.set(key, finalValue, { ex: ttlSeconds });
			} else {
				await redis.set(key, finalValue);
			}
		});
		return 'written';
	} catch (e: any) {
		noteRedisError(e, 'setIfValid');
		const msg = String(e?.message || e || '').toLowerCase();
		if (msg.includes('wrongtype')) return 'skipped-nonstring';
		console.warn('redisCache.setIfValid error', e?.message || e);
		return 'error';
	}
}

export async function setStringIfValid(
	key: string,
	raw: string,
	ttlSeconds: number | null = DEFAULT_TTL_SECONDS,
): Promise<'written' | 'skipped-empty' | 'skipped-nonstring' | 'no-client' | 'error'> {
	try {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
		if (isEmptyHitsObj(parsed)) return 'skipped-empty';
		if (!canWriteToRedis()) {
			return 'no-client';
		}
		const redis = getRedisClient();
		if (!redis) return 'no-client';
		// Skip TYPE-before-SET (saves ~1 command per write). WRONGTYPE → skipped-nonstring.
		await limiter.schedule(async () => {
			const finalValue = compressPayload(raw);
			if (ttlSeconds) {
				await redis.set(key, finalValue, { ex: ttlSeconds });
			} else {
				await redis.set(key, finalValue);
			}
		});
		return 'written';
	} catch (e: any) {
		noteRedisError(e, 'setStringIfValid');
		const msg = String(e?.message || e || '').toLowerCase();
		if (msg.includes('wrongtype')) return 'skipped-nonstring';
		console.warn('redisCache.setStringIfValid error', e?.message || e);
		return 'error';
	}
}

const redisCache = { setIfValid, setStringIfValid, isEmptyHitsObj };
export default redisCache;
