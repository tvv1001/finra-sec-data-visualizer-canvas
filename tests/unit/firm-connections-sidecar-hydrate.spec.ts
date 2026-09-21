import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, lookupLocalSearchHitsByIds } = vi.hoisted(() => ({
	mockRedis: {
		get: vi.fn(),
		mget: vi.fn(),
		del: vi.fn(),
	},
	lookupLocalSearchHitsByIds: vi.fn(async () => new Map()),
}));

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
	setStringIfValid: vi.fn(async () => 'written'),
	decompressPayload: (value: string) => value,
}));

vi.mock('@/lib/localSearch', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/localSearch')>();
	return {
		...actual,
		lookupLocalSearchHitsByIds,
	};
});

vi.mock('@/lib/firmEmploymentFromPrimed', () => ({
	lookupFirmEmploymentEdgesFromPrimed: vi.fn(async () => ({ edges: [], source: 'adj' })),
	getFirmEmploymentEdgesFromPrimed: vi.fn(async () => []),
}));

vi.mock('@/lib/officialFirmRoster', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/officialFirmRoster')>();
	return {
		...actual,
		fetchOfficialFirmRoster: vi.fn(async () => null),
	};
});

import {
	firmConnectionsCacheKey,
	getFirmConnectionsFromGraph,
	hydrateFirmConnectionsFromSearchSidecar,
} from '@/lib/graphConnections';

describe('firm connections sidecar hydration', () => {
	beforeEach(() => {
		mockRedis.get.mockReset();
		lookupLocalSearchHitsByIds.mockReset();
	});

	it('hydrates thin names from search sidecar without Redis detail GETs', async () => {
		lookupLocalSearchHitsByIds.mockResolvedValue(
			new Map([
				[
					'1085996',
					{
						ind_firstname: 'Timothy',
						ind_middlename: 'Dale',
						ind_lastname: 'Register',
						ind_other_names: ['Register Tim'],
						ind_bc_scope: 'InActive',
						ind_previous_employments: [{ firmId: '7691', city: 'Buffalo', state: 'NY' }],
					},
				],
			]),
		);

		const hydrated = await hydrateFirmConnectionsFromSearchSidecar(
			{
				currentConnections: [],
				previousConnections: [
					{
						individualId: '1085996',
						name: 'Timothy',
						relationship: 'Previous registration',
						isCurrent: false,
					},
				],
			},
			'7691',
		);

		expect(hydrated.previousConnections[0]).toMatchObject({
			individualId: '1085996',
			name: 'Timothy Dale Register',
			address: 'Buffalo, NY',
			bcScope: 'InActive',
		});
		expect(hydrated.previousConnections[0].evidence).toContain('sidecar-hydrated');
	});

	it('runs sidecar hydrate on light/skipEnrichment firm connections path', async () => {
		lookupLocalSearchHitsByIds.mockResolvedValue(
			new Map([
				[
					'1085996',
					{
						ind_firstname: 'Timothy',
						ind_middlename: 'Dale',
						ind_lastname: 'Register',
					},
				],
			]),
		);
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('7691')) {
				return JSON.stringify({
					currentConnections: [],
					previousConnections: [
						{
							individualId: '1085996',
							name: 'Tim',
							relationship: 'Previous registration',
							isCurrent: false,
						},
					],
				});
			}
			return null;
		});

		const result = await getFirmConnectionsFromGraph('7691', { skipEnrichment: true });
		expect(result.previousConnections[0].name).toBe('Timothy Dale Register');
		expect(lookupLocalSearchHitsByIds).toHaveBeenCalled();
	});
});
