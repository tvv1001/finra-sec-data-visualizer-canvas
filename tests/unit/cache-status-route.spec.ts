import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockReadFile, mockStat, mockIsRedisCacheOnly, mockGetRedisUnusableReason } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockStat: vi.fn(),
	mockIsRedisCacheOnly: vi.fn(),
	mockGetRedisUnusableReason: vi.fn(),
}));

vi.mock('fs/promises', async () => {
	const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
	return {
		...actual,
		default: {
			...actual,
			readFile: mockReadFile,
			stat: mockStat,
		},
		readFile: mockReadFile,
		stat: mockStat,
	};
});

vi.mock('@/lib/redisAvailability', () => ({
	isRedisCacheOnly: mockIsRedisCacheOnly,
	getRedisUnusableReason: mockGetRedisUnusableReason,
}));

import { GET } from '../../src/app/api/cache/status/route';

describe('/api/cache/status', () => {
	beforeEach(() => {
		mockReadFile.mockReset();
		mockStat.mockReset();
		mockIsRedisCacheOnly.mockReset().mockReturnValue(false);
		mockGetRedisUnusableReason.mockReset().mockReturnValue('');
	});

	it('does not 500 when the optional data/national graph snapshot is absent', async () => {
		mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));

		const response = await GET();
		expect(response.status).toBe(200);

		const payload = await response.json();
		expect(payload.ok).toBe(true);
		expect(payload.graphAvailable).toBe(false);
		expect(payload.items).toEqual([]);
		expect(payload.count).toBe(0);
		expect(payload.architecture).toBeDefined();
	});

	it('reports cache-only architecture when Redis is unusable', async () => {
		mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
		mockIsRedisCacheOnly.mockReturnValue(true);
		mockGetRedisUnusableReason.mockReturnValue('quota-exceeded');

		const response = await GET();
		const payload = await response.json();

		expect(payload.ok).toBe(true);
		expect(payload.architecture.cacheOnly).toBe(true);
		expect(payload.architecture.mode).toBe('cache-only');
		expect(payload.architecture.cacheOnlyReason).toBe('quota-exceeded');
	});

	it('reports graphAvailable true and inspects nodes when the snapshot is present', async () => {
		mockReadFile.mockResolvedValue(
			JSON.stringify({
				nodes: [{ firmId: '100', hasFinraPage: true }],
			}),
		);
		mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

		const response = await GET();
		const payload = await response.json();

		expect(payload.ok).toBe(true);
		expect(payload.graphAvailable).toBe(true);
		expect(payload.count).toBe(1);
		expect(payload.items[0]).toMatchObject({ type: 'finra-firm', id: '100' });
	});
});
