/**
 * Soft Redis availability for production Upstash.
 * When Redis cannot read/write (limit errors, forced env, etc.), the app runs cache-only
 * from process mem, primed/disk, firm-connections files, and search sidecars.
 * Local Redis (`USE_LOCAL_REDIS=1`) is never auto-marked unusable — only `REDIS_CACHE_ONLY=1`.
 */

let redisUnusable = false;
let redisUnusableReason = '';

function envForcesCacheOnly(): boolean {
	const v = String(process.env.REDIS_CACHE_ONLY || '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes';
}

function isLocalRedis(): boolean {
	return String(process.env.USE_LOCAL_REDIS || '') === '1';
}

/** True when callers should skip Redis and use mem/disk/sidecars only. */
export function isRedisCacheOnly(): boolean {
	if (envForcesCacheOnly()) return true;
	if (isLocalRedis()) return false;
	return redisUnusable;
}

export function getRedisUnusableReason(): string {
	if (envForcesCacheOnly()) return 'REDIS_CACHE_ONLY';
	return redisUnusableReason || '';
}

/** Mark Upstash unusable for this process (limit/network/auth). Local Redis ignores this. */
export function markRedisUnusable(reason: string): void {
	if (isLocalRedis() && !envForcesCacheOnly()) return;
	const next = String(reason || 'unknown').slice(0, 200);
	if (!redisUnusable) {
		console.warn(`[Redis] cache-only mode enabled: ${next}`);
	}
	redisUnusable = true;
	redisUnusableReason = next;
}

/** Inspect an error and flip cache-only on quota/limit/auth/network class failures. */
export function noteRedisError(err: unknown, context?: string): void {
	const msg = String((err as any)?.message || err || '').toLowerCase();
	if (!msg) return;
	const unusable =
		msg.includes('max') ||
		msg.includes('limit') ||
		msg.includes('exceeded') ||
		msg.includes('daily') ||
		msg.includes('quota') ||
		msg.includes('too many requests') ||
		msg.includes('429') ||
		msg.includes('unauthorized') ||
		msg.includes('forbidden') ||
		msg.includes('econnrefused') ||
		msg.includes('enotfound') ||
		msg.includes('fetch failed') ||
		msg.includes('network');
	if (unusable) {
		markRedisUnusable(context ? `${context}: ${msg.slice(0, 120)}` : msg.slice(0, 160));
	}
}

/** Test helper — reset process-local unusable flag. */
export function resetRedisAvailabilityForTests(): void {
	redisUnusable = false;
	redisUnusableReason = '';
}

/** True when interactive Redis writes are allowed (env + not cache-only). */
export function canWriteToRedis(): boolean {
	if (isRedisCacheOnly()) return false;
	return String(process.env.UPSTASH_ALLOW_WRITES || '0') === '1';
}

/** True when Redis reads should be attempted (false in cache-only / R+W disabled mode). */
export function canReadFromRedis(): boolean {
	return !isRedisCacheOnly();
}
