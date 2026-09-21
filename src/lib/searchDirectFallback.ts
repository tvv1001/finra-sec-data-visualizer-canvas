import type { Redis } from '@upstash/redis';
import { getRedisClientInstance } from '@/lib/redisClient';
import { decompressPayload } from '@/lib/redisCache';
import type { LocalSearchEntity, LocalSearchResponse, LocalSearchSource } from './localSearch';

let cachedRedisClient: Redis | null = null;
function getUpstashClient() {
	if (cachedRedisClient) return cachedRedisClient;
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	cachedRedisClient = getRedisClientInstance({ url, token });
	return cachedRedisClient;
}


export async function searchDirectRedisFallback(
	source: LocalSearchSource,
	type: LocalSearchEntity,
	query: string,
	options: { limit?: number; offset?: number } = {},
): Promise<LocalSearchResponse | null> {
	const normalizedQuery = String(query || '').trim();
	// Only fallback for identifier-like queries (pure numbers or 8-xxx)
	if (!/^(?:\d{1,10}|8-\d+)$/.test(normalizedQuery)) return null;

	const redis = getUpstashClient();
	if (!redis) return null;

	try {
		const key = `${source}:${type}:${normalizedQuery}`;
		const raw = await redis.get(key);
		if (!raw) return null;

		// Support brotli `br:` binary cache payloads without scanning other keys.
		const rawDoc =
			typeof raw === 'string' ?
				(() => {
					const text = decompressPayload(raw);
					return typeof text === 'string' ? JSON.parse(text) : text;
				})()
			:	raw;

		// If it's wrapped in a finra/sec search response format, extract the actual _source
		let doc = rawDoc;
		if (doc?.hits?.hits?.[0]?._source) {
			doc = doc.hits.hits[0]._source;
		} else if (doc?._source) {
			doc = doc._source;
		}

		if (doc?.content && typeof doc.content === 'string') {
			try {
				doc = JSON.parse(doc.content);
			} catch {
				// ignore
			}
		}

		// Ensure it has an identifier so mergeLocalSearchResponses doesn't drop it
		if (type === 'individual' && !doc.id && !doc.ind_source_id) {
			doc.ind_source_id = normalizedQuery;
		} else if (type === 'firm' && !doc.id && !doc.firm_source_id) {
			doc.firm_source_id = normalizedQuery;
		}

		const id = type === 'individual' ? `person:${normalizedQuery}` : `firm:${normalizedQuery}`;

		const limit = options.limit ?? 12;
		const offset = options.offset ?? 0;

		return {
			bucket: `${source}:${type}`,
			generatedAt: new Date().toISOString(),
			total: 1,
			hits: {
				total: 1,
				start: offset,
				hits: [{ _id: id, _source: doc }],
			},
			response: {
				numFound: 1,
				start: offset,
				docs: [doc],
			},
			results: [doc],
			currentPage: [doc],
			pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
			pageSize: limit,
		};
	} catch (err) {
		console.warn(`[searchDirectRedisFallback] Failed to fetch direct record from Redis for ${source}:${type}:${normalizedQuery}`, err);
		return null;
	}
}
