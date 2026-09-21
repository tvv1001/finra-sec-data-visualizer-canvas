import { afterEach, describe, expect, it } from 'vitest';
import {
	canReadFromRedis,
	canWriteToRedis,
	getRedisUnusableReason,
	isRedisCacheOnly,
	markRedisUnusable,
	noteRedisError,
	resetRedisAvailabilityForTests,
} from '@/lib/redisAvailability';

describe('redisAvailability', () => {
	afterEach(() => {
		resetRedisAvailabilityForTests();
		delete process.env.REDIS_CACHE_ONLY;
		delete process.env.USE_LOCAL_REDIS;
		delete process.env.UPSTASH_ALLOW_WRITES;
	});

	it('forces cache-only when REDIS_CACHE_ONLY=1', () => {
		process.env.REDIS_CACHE_ONLY = '1';
		expect(isRedisCacheOnly()).toBe(true);
		expect(getRedisUnusableReason()).toBe('REDIS_CACHE_ONLY');
		expect(canWriteToRedis()).toBe(false);
		expect(canReadFromRedis()).toBe(false);
	});

	it('does not auto-mark local Redis unusable', () => {
		process.env.USE_LOCAL_REDIS = '1';
		markRedisUnusable('max requests exceeded');
		expect(isRedisCacheOnly()).toBe(false);
	});

	it('marks Upstash unusable on limit-class errors', () => {
		delete process.env.USE_LOCAL_REDIS;
		noteRedisError(new Error('max requests exceeded daily'), 'get');
		expect(isRedisCacheOnly()).toBe(true);
		expect(canWriteToRedis()).toBe(false);
	});

	it('allows writes only when UPSTASH_ALLOW_WRITES=1 and not cache-only', () => {
		process.env.UPSTASH_ALLOW_WRITES = '1';
		expect(canWriteToRedis()).toBe(true);
		process.env.REDIS_CACHE_ONLY = '1';
		expect(canWriteToRedis()).toBe(false);
	});
});
