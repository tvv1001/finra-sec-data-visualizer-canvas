import { describe, it, expect, vi, beforeEach } from 'vitest';

const setMock = vi.fn();
const typeMock = vi.fn();

vi.mock('@upstash/redis', () => {
	return {
		Redis: class Redis {
			constructor() {
				// no-op
			}
			type = typeMock;
			set = setMock;
			get = vi.fn(async () => null);
		},
	};
});

vi.mock('@/lib/redisClient', () => ({
	getRedisClientInstance: () => ({
		type: typeMock,
		set: setMock,
		get: vi.fn(async () => null),
	}),
}));

beforeEach(() => {
	vi.resetModules();
	setMock.mockClear();
	typeMock.mockClear();
	process.env.UPSTASH_REDIS_REST_URL = 'https://x';
	process.env.UPSTASH_REDIS_REST_TOKEN = 't';
	process.env.UPSTASH_ALLOW_WRITES = '1';
	delete process.env.REDIS_CACHE_ONLY;
	delete process.env.USE_LOCAL_REDIS;
});

describe('redisCache helper', () => {
	it('isEmptyHitsObj recognizes empty hits shapes', async () => {
		const { isEmptyHitsObj } = await import('@/lib/redisCache');
		expect(isEmptyHitsObj({ hits: { total: 0, hits: [] } })).toBe(true);
		expect(isEmptyHitsObj({ hits: { total: { value: 0 }, hits: [] } })).toBe(true);
		expect(isEmptyHitsObj({})).toBe(false);
		expect(isEmptyHitsObj(null)).toBe(false);
		expect(isEmptyHitsObj({ hits: { total: 1, hits: [] } })).toBe(false);
		expect(isEmptyHitsObj({ hits: { total: 0, hits: [{ id: 1 }] } })).toBe(false);
	});

	it('setStringIfValid skips empty hits and does not call redis.set', async () => {
		const { setStringIfValid } = await import('@/lib/redisCache');
		const raw = JSON.stringify({ hits: { total: 0, hits: [] } });
		const res = await setStringIfValid('finra:foo', raw, 10);
		expect(res).toBe('skipped-empty');
		expect(setMock).not.toHaveBeenCalled();
	});

	it('setStringIfValid writes without TYPE-before-SET', async () => {
		const { setStringIfValid } = await import('@/lib/redisCache');
		const raw = JSON.stringify({ data: 1 });
		const res = await setStringIfValid('finra:baz', raw, 7);
		expect(res).toBe('written');
		expect(typeMock).not.toHaveBeenCalled();
		expect(setMock).toHaveBeenCalled();
		expect(setMock.mock.calls[0][0]).toBe('finra:baz');
		expect(setMock.mock.calls[0][2]).toMatchObject({ ex: 7 });
	});

	it('setIfValid writes object values when valid', async () => {
		const { setIfValid } = await import('@/lib/redisCache');
		const res = await setIfValid('finra:obj', { foo: 'bar' }, 9);
		expect(res).toBe('written');
		expect(setMock).toHaveBeenCalled();
		expect(typeMock).not.toHaveBeenCalled();
	});

	it('setStringIfValid no-ops when writes disabled', async () => {
		process.env.UPSTASH_ALLOW_WRITES = '0';
		const { setStringIfValid } = await import('@/lib/redisCache');
		const res = await setStringIfValid('finra:baz', JSON.stringify({ data: 1 }), 7);
		expect(res).toBe('no-client');
		expect(setMock).not.toHaveBeenCalled();
	});

	it('setStringIfValid no-ops in REDIS_CACHE_ONLY mode', async () => {
		process.env.REDIS_CACHE_ONLY = '1';
		const { setStringIfValid } = await import('@/lib/redisCache');
		const res = await setStringIfValid('finra:baz', JSON.stringify({ data: 1 }), 7);
		expect(res).toBe('no-client');
		expect(setMock).not.toHaveBeenCalled();
	});
});
