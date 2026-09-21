import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';
import { isRedisCacheOnly, markRedisUnusable, noteRedisError } from '@/lib/redisAvailability';

let localIoRedis: IORedis | null = null;
// Cache Upstash client instances to avoid recreating HTTP clients on every
// invocation which adds latency and extra resource usage.
const upstashClientCache = new Map<string, UpstashRedis>();

const READ_METHODS = new Set([
	'get',
	'mget',
	'scan',
	'zrange',
	'smembers',
	'hgetall',
	'exists',
	'dbsize',
	'type',
	'keys',
	'hget',
	'zrevrange',
	'zscore',
	'zrank',
	'lrange',
]);
const WRITE_METHODS = new Set([
	'set',
	'mset',
	'hset',
	'zadd',
	'sadd',
	'del',
	'incr',
	'incrby',
	'expire',
	'flushall',
	'flushdb',
	'lpush',
	'ltrim',
	'rpush',
]);

function emptyReadResult(method: string): unknown {
	if (method === 'scan') return ['0', []];
	if (method === 'mget' || method === 'zrange' || method === 'zrevrange' || method === 'smembers' || method === 'keys' || method === 'lrange')
		return [];
	if (method === 'exists' || method === 'dbsize') return 0;
	if (method === 'hgetall') return {};
	return null;
}

/** When cache-only, short-circuit Redis; on limit-class errors, flip cache-only. */
function wrapClientForCacheOnly(client: UpstashRedis): UpstashRedis {
	return new Proxy(client, {
		get(target, prop) {
			const val = (target as any)[prop];
			if (typeof val !== 'function') return val;
			const propStr = String(prop);
			return function (...args: any[]) {
				if (isRedisCacheOnly()) {
					if (WRITE_METHODS.has(propStr)) return Promise.resolve(undefined);
					if (READ_METHODS.has(propStr)) return Promise.resolve(emptyReadResult(propStr));
					return Promise.resolve(undefined);
				}
				try {
					const result = val.apply(target, args);
					if (result && typeof result.then === 'function') {
						return result.catch((err: any) => {
							noteRedisError(err, propStr);
							if (isRedisCacheOnly()) {
								if (WRITE_METHODS.has(propStr)) return undefined;
								if (READ_METHODS.has(propStr)) return emptyReadResult(propStr);
								return undefined;
							}
							throw err;
						});
					}
					return result;
				} catch (err) {
					noteRedisError(err, propStr);
					if (isRedisCacheOnly()) {
						if (WRITE_METHODS.has(propStr)) return Promise.resolve(undefined);
						if (READ_METHODS.has(propStr)) return Promise.resolve(emptyReadResult(propStr));
						return Promise.resolve(undefined);
					}
					throw err;
				}
			};
		},
	});
}

function decodeRedisResult(value: any): any {
	if (Buffer.isBuffer(value)) return value.toString('utf-8');
	if (Array.isArray(value)) return value.map(decodeRedisResult);
	return value;
}

async function executeLocalRequest(req: any): Promise<any> {
	if (!localIoRedis) {
		localIoRedis = new IORedis('redis://127.0.0.1:6379');
		// Enable LRU caching on local Redis so it behaves like a bounded cache instead of an unbound DB
		localIoRedis.config('SET', 'maxmemory', '512mb').catch(() => {});
		localIoRedis.config('SET', 'maxmemory-policy', 'allkeys-lru').catch(() => {});
		console.log('Other local applications can now connect to your shared local cache at redis://127.0.0.1:6379!');
	}

	let body = req.body || [];
	if (typeof body === 'string') {
		body = JSON.parse(body);
	}

	if (Array.isArray(body) && Array.isArray(body[0])) {
		// pipeline
		const pipeline = localIoRedis.pipeline();
		body.forEach((cmd: any) => {
			// @ts-ignore
			pipeline.sendCommand(new IORedis.Command(cmd[0], cmd.slice(1)));
		});
		const res = await pipeline.exec();
		return res?.map((r) => (r[0] ? { error: r[0].message } : { result: decodeRedisResult(r[1]) }));
	} else if (Array.isArray(body)) {
		try {
			const res = await localIoRedis.sendCommand(new IORedis.Command(body[0], body.slice(1)));
			return { result: decodeRedisResult(res) };
		} catch (e: any) {
			return { error: e.message };
		}
	} else {
		return { error: 'Invalid payload' };
	}
}


export function getRedisClientInstance(config: { url: string; token: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';

	if (isLocalhost) {
		return wrapClientForCacheOnly(
			new UpstashRedis({
				request: executeLocalRequest,
			} as any),
		);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	// prefer the MIRROR env var but fall back to legacy _2 env names for compatibility
	const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);
	const disableDb2 = process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' || process.env.UPSTASH_REDIS_DISABLE_2 === '1';

	// If DB2 is explicitly disabled via env, prefer DB1 when available and avoid the dual-proxy.
	if (hasDb1 && hasDb2 && !disableDb2) {
		const dualCacheKey = `dual:${url1}:${token1}:${url2}:${token2}:co`;
		const existingProxy = upstashClientCache.get(dualCacheKey);
		if (existingProxy) return existingProxy;

		const cacheKey1 = `${url1}:${token1}`;
		const cacheKey2 = `${url2}:${token2}`;
		const client1 = upstashClientCache.get(cacheKey1) ?? new UpstashRedis({ url: url1, token: token1 });
		const client2 = upstashClientCache.get(cacheKey2) ?? new UpstashRedis({ url: url2, token: token2 });
		upstashClientCache.set(cacheKey1, client1);
		upstashClientCache.set(cacheKey2, client2);

		let db1Maxxed = false;
		let db2Maxxed = false;

		const checkMaxxed = (err: any, dbIndex: 1 | 2) => {
			const msg = String(err?.message || '').toLowerCase();
			// Treat auth failures like a dead DB for this process so we stop retrying a bad
			// token on every request (prod WRONGPASS on DB1 was doubling latency).
			const authDead =
				msg.includes('wrongpass') ||
				msg.includes('invalid or missing auth') ||
				msg.includes('unauthorized') ||
				msg.includes('forbidden') ||
				msg.includes('401') ||
				msg.includes('403');
			const quotaDead =
				msg.includes('max') ||
				msg.includes('limit') ||
				msg.includes('exceeded') ||
				msg.includes('daily') ||
				msg.includes('quota') ||
				msg.includes('too many requests') ||
				msg.includes('429');
			if (!authDead && !quotaDead) return;
			if (dbIndex === 1) db1Maxxed = true;
			else db2Maxxed = true;
			console.warn(`[Redis LB] DB${dbIndex} marked offline (${authDead ? 'auth' : 'quota'})!`);
			// Only flip global cache-only when BOTH DBs are unusable — a single bad
			// credential / quota must not disable the healthy mirror.
			if (db1Maxxed && db2Maxxed) {
				markRedisUnusable(authDead ? 'both Upstash DBs auth-failed' : 'both Upstash DBs maxxed');
			}
		};

		const dualProxy = new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function (...args: any[]) {
						const propStr = prop as string;
						if (READ_METHODS.has(propStr)) {
							return (async () => {
								if (isRedisCacheOnly() || (db1Maxxed && db2Maxxed)) {
									return emptyReadResult(propStr);
								}

								let primary = client2;
								let secondary = client1;
								let primaryIndex: 1 | 2 = 2;
								let secondaryIndex: 1 | 2 = 1;

								if (!db1Maxxed && (db2Maxxed || Math.random() < 0.5)) {
									primary = client1;
									secondary = client2;
									primaryIndex = 1;
									secondaryIndex = 2;
								}

								try {
									let res = await (primary as any)[propStr](...args);

									// Fallback if null (helpful during partial migrations), only if other DB is healthy
									let needsFallback = res === null || res === undefined;
									if (Array.isArray(res) && res.length > 0 && res.some((item) => item === null || item === undefined)) {
										needsFallback = true;
									}

									if (needsFallback && !db1Maxxed && !db2Maxxed) {
										res = await (secondary as any)[propStr](...args);
									}
									return res;
								} catch (err: any) {
									checkMaxxed(err, primaryIndex);
									if (db1Maxxed && db2Maxxed) {
										return emptyReadResult(propStr);
									}
									console.warn(`[Redis LB] Error on DB${primaryIndex} for ${propStr}, falling back to DB${secondaryIndex}... (${err.message})`);
									try {
										return await (secondary as any)[propStr](...args);
									} catch (err2: any) {
										checkMaxxed(err2, secondaryIndex);
										return emptyReadResult(propStr);
									}
								}
							})();
						} else if (WRITE_METHODS.has(propStr)) {
							return (async () => {
								if (isRedisCacheOnly()) return undefined;
								// Perform writes to both DBs concurrently. Await both fully before
								// returning so Serverless/Edge does not drop the second write.
								const wrapped = (p: Promise<any>, dbIndex: 1 | 2) =>
									p
										.then((res) => ({ ok: true, res, dbIndex }))
										.catch((e: any) => {
											checkMaxxed(e, dbIndex);
											console.error(`[Redis LB] Write error DB${dbIndex}:`, e?.message || e);
											return { ok: false, err: e, dbIndex };
										});

								const promises: Array<Promise<any>> = [];
								if (!db1Maxxed) promises.push(wrapped((client1 as any)[propStr](...args), 1));
								else promises.push(Promise.resolve({ ok: false, dbIndex: 1 }));

								if (!db2Maxxed) promises.push(wrapped((client2 as any)[propStr](...args), 2));
								else promises.push(Promise.resolve({ ok: false, dbIndex: 2 }));

								try {
									const all = await Promise.all(promises);
									let successRes = undefined;
									for (const a of all) {
										if (a && a.ok) successRes = a.res;
									}
									return successRes;
								} catch {
									const settled = await Promise.allSettled(promises);
									for (const s of settled) {
										if ((s as any).status === 'fulfilled' && (s as any).value && (s as any).value.ok) return (s as any).value.res;
									}
									return undefined;
								}
							})();
						}
						// Direct passthrough for other methods (like pipeline)
						return (db1Maxxed ? client2 : (client1 as any))[propStr](...args);
					};
				}
				return val;
			},
		}) as UpstashRedis;

		const wrappedProxy = wrapClientForCacheOnly(dualProxy);
		upstashClientCache.set(dualCacheKey, wrappedProxy);
		return wrappedProxy;
	}

	// Single-instance behavior. Prefer DB1 when present; otherwise use DB2 or the provided config.
	if (hasDb1) {
		const cacheKey = `${url1}:${token1}:co`;
		const c =
			upstashClientCache.get(cacheKey) ??
			wrapClientForCacheOnly(new UpstashRedis({ url: url1, token: token1 }));
		upstashClientCache.set(cacheKey, c);
		return c;
	}
	if (hasDb2) {
		const cacheKey = `${url2}:${token2}:co`;
		const c =
			upstashClientCache.get(cacheKey) ??
			wrapClientForCacheOnly(new UpstashRedis({ url: url2, token: token2 }));
		upstashClientCache.set(cacheKey, c);
		return c;
	}

	const cfgKey = `${config.url}:${config.token}:co`;
	const c =
		upstashClientCache.get(cfgKey) ??
		wrapClientForCacheOnly(new UpstashRedis({ url: config.url, token: config.token }));
	upstashClientCache.set(cfgKey, c);
	return c;
}

/**
 * Return a read-only Upstash client (or proxied client) that will only execute
 * read methods against DB1/DB2. Writes will be rejected to ensure the caller
 * cannot modify state. This is intended for applications that should only
 * read from the cache (e.g., analytics or reporting services).
 */
export function getReadOnlyRedisClientInstance(config?: { url?: string; token?: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';
	if (isLocalhost) {
		// Local proxy still supports read-only usage via the normal Upstash wrapper
		return new UpstashRedis({ request: executeLocalRequest } as any);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL || config?.url;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || config?.url;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);
	const disableDb2 = process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' || process.env.UPSTASH_REDIS_DISABLE_2 === '1';

	const readMethods = new Set(['get', 'mget', 'scan', 'zrange', 'smembers', 'hgetall', 'exists', 'dbsize', 'type', 'keys', 'hget', 'zrevrange', 'zscore', 'zrank', 'zincrby']);

	const checkMaxxed = (err: any, dbIndex: 1 | 2) => {
		const msg = String(err?.message || '').toLowerCase();
		if (msg.includes('max') || msg.includes('limit') || msg.includes('exceeded') || msg.includes('daily')) {
			// noop for read-only: log only
			console.warn(`[Redis RO] DB${dbIndex} marked as maxxed out (read)!`);
		}
	};

	if (hasDb1 && hasDb2 && !disableDb2) {
		const client1 = new UpstashRedis({ url: url1, token: token1 });
		const client2 = new UpstashRedis({ url: url2, token: token2 });

		return new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function (...args: any[]) {
						const propStr = prop as string;
						if (!readMethods.has(propStr)) {
							return Promise.reject(new Error('Redis client is read-only: write methods are not allowed'));
						}
						return (async () => {
							// choose between DB1/DB2 for reads (same strategy as main client)
							let primary = client2;
							let secondary = client1;
							if (Math.random() < 0.5) {
								primary = client1;
								secondary = client2;
							}
							try {
								let res = await (primary as any)[propStr](...args);
								if (res === null || res === undefined) {
									res = await (secondary as any)[propStr](...args);
								}
								return res;
							} catch (err: any) {
								checkMaxxed(err, 1);
								try {
									return await (secondary as any)[propStr](...args);
								} catch (err2: any) {
									checkMaxxed(err2, 2);
									return null;
								}
							}
						})();
					};
				}
				return val;
			},
		});
	}

	if (hasDb1) return new UpstashRedis({ url: url1, token: token1 });
	if (hasDb2) return new UpstashRedis({ url: url2, token: token2 });

	return new UpstashRedis({ url: config?.url || '', token: config?.token || '' });
}
