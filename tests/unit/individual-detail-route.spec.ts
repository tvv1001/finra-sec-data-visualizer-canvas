import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cachedFetch = vi.fn();
const rememberRecentSeed = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn() };
const normalizeIndividualDetailFromSource = vi.fn();
const addRecordToSearchIndex = vi.fn();
const globalFetchMock = vi.fn();

vi.mock('@/lib/simpleCache', () => ({
	cachedFetch,
}));

vi.mock('@/lib/seedStore', () => ({
	rememberRecentSeed,
}));

vi.mock('@/lib/httpCache', () => ({
	sharedCacheHeaders: vi.fn(() => ({ 'Cache-Control': 'max-age=60' })),
}));

vi.mock('@/lib/logger', () => ({
	logger,
}));

vi.mock('@/lib/individualDetail', () => ({
	normalizeIndividualDetailFromSource,
}));

vi.mock('@/lib/localSearch', () => ({
	addRecordToSearchIndex,
}));

vi.mock('@/lib/sourceTruth', () => ({
	hasIndividualSourceCoverage: vi.fn(() => false),
	resolveIndividualSourceDetail: vi.fn((source: unknown) => ({
		detail: source,
		hasEmbeddedDetail: false,
		hasFinraData: false,
		hasSecData: false,
		searchHitOnly: false,
	})),
}));

const { GET } = await import('@/app/api/finra/individual/[crd]/route');

describe('individual detail route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', globalFetchMock);
		globalFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
		cachedFetch.mockResolvedValue(undefined);
		rememberRecentSeed.mockResolvedValue(undefined);
		addRecordToSearchIndex.mockResolvedValue(true);
	});

	it('returns a non-500 response when detail normalization throws', async () => {
		normalizeIndividualDetailFromSource.mockImplementation(() => {
			throw new Error('boom');
		});

		const response = await GET(new NextRequest('http://localhost/api/finra/individual/7330393'), { params: Promise.resolve({ crd: '7330393' }) });
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({ found: false, crd: '7330393' });
	});

	it('adds freshly fetched individual details to the local search index', async () => {
		cachedFetch.mockResolvedValue({
			hits: {
				hits: [{ _source: { content: JSON.stringify({ basicInformation: { individualId: '7330393', firstName: 'Jane', lastName: 'Doe' } }) } }],
			},
		});
		normalizeIndividualDetailFromSource.mockImplementation((value: unknown) => {
			if (value && typeof value === 'object' && 'content' in value && typeof (value as { content?: unknown }).content === 'string') {
				try {
					return JSON.parse((value as { content: string }).content);
				} catch {
					return value;
				}
			}
			return value;
		});

		const response = await GET(new NextRequest('http://localhost/api/finra/individual/7330393'), { params: Promise.resolve({ crd: '7330393' }) });
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({ found: true, crd: '7330393' });
		expect(addRecordToSearchIndex).toHaveBeenCalledWith(
			'finra',
			'individual',
			'7330393',
			expect.objectContaining({ basicInformation: expect.objectContaining({ individualId: '7330393' }) }),
		);
	});

	it('falls back to direct FINRA fetch when cached FINRA detail is missing but SEC shell indicates FINRA coverage', async () => {
		cachedFetch.mockImplementation(async (key: string) => {
			if (key.startsWith('finra:individual:')) return undefined;
			if (key.startsWith('sec:individual:')) {
				return {
					iacontent: {
						basicInformation: {
							individualId: 8275843,
							firstName: 'DECLAN',
							lastName: 'GOREY',
							bcScope: 'Active',
							iaScope: 'NotInScope',
						},
						currentEmployments: [],
						currentIAEmployments: [],
						previousEmployments: [],
						previousIAEmployments: [],
						registrationCount: {
							approvedFinraRegistrationCount: 1,
							approvedSRORegistrationCount: 25,
							approvedStateRegistrationCount: 0,
							approvedIAStateRegistrationCount: 0,
						},
						registeredSROs: [{ sro: 'FINRA', status: 'APPROVED' }],
						brokerDetails: { hasBCComments: 'N' },
					},
				};
			}
			return undefined;
		});

		globalFetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				hits: {
					hits: [
						{
							_source: {
								content: JSON.stringify({
									basicInformation: {
										individualId: 8275843,
										firstName: 'DECLAN',
										lastName: 'GOREY',
										bcScope: 'Active',
										iaScope: 'NotInScope',
									},
									currentEmployments: [
										{
											firmId: 128030,
											firmName: 'OPTIVER US LLC',
											registrationBeginDate: '7/8/2026',
										},
									],
									currentIAEmployments: [],
									previousEmployments: [],
									previousIAEmployments: [],
								}),
							},
						},
					],
				},
			}),
		});

		normalizeIndividualDetailFromSource.mockImplementation((value: unknown) => {
			if (!value || typeof value !== 'object') return value;
			if ('content' in value && typeof (value as { content?: unknown }).content === 'string') {
				try {
					return JSON.parse((value as { content: string }).content);
				} catch {
					return value;
				}
			}
			return value;
		});

		const response = await GET(new NextRequest('http://localhost/api/finra/individual/8275843'), { params: Promise.resolve({ crd: '8275843' }) });
		const payload = await response.json();
		const bccontentNormalized =
			payload?.bccontent && typeof payload.bccontent === 'object' && typeof payload.bccontent.content === 'string' ? JSON.parse(payload.bccontent.content) : payload?.bccontent;

		expect(response.status).toBe(200);
		expect(globalFetchMock).toHaveBeenCalledTimes(1);
		expect(payload).toMatchObject({ found: true, crd: '8275843' });
		expect(Array.isArray(bccontentNormalized?.currentEmployments)).toBe(true);
		expect(bccontentNormalized.currentEmployments.length).toBeGreaterThan(0);
		expect(bccontentNormalized.currentEmployments[0]).toMatchObject({
			firmId: 128030,
			firmName: 'OPTIVER US LLC',
		});
		expect(addRecordToSearchIndex).toHaveBeenCalledWith(
			'finra',
			'individual',
			'8275843',
			expect.objectContaining({
				currentEmployments: expect.arrayContaining([expect.objectContaining({ firmId: 128030 })]),
			}),
		);
	});
});
