import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
	saveGraph: vi.fn(),
}));

vi.mock('@/lib/localSearch', () => ({
	searchLocalIndex: vi.fn(async () => ({
		bucket: 'finra:individual',
		generatedAt: null,
		total: 0,
		hits: { total: 0, start: 0, hits: [] },
		response: { numFound: 0, start: 0, docs: [] },
		results: [],
		currentPage: [],
		pageNumber: 1,
		pageSize: 0,
	})),
	searchLocalIndexMany: vi.fn(async () => ({
		bucket: 'finra:individual',
		generatedAt: null,
		total: 0,
		hits: { total: 0, start: 0, hits: [] },
		response: { numFound: 0, start: 0, docs: [] },
		results: [],
		currentPage: [],
		pageNumber: 1,
		pageSize: 0,
	})),
	cleanSearchQuery: vi.fn((q) => q),
	extractSearchQueries: vi.fn((q) => [q]),
}));

vi.mock('@/lib/individualDetail', () => ({
	normalizeIndividualDetailFromSource: vi.fn((value) => value),
}));

vi.mock('@upstash/redis', () => ({
	Redis: class RedisMock {
		async lpush() {
			return 0;
		}
		async ltrim() {
			return 0;
		}
	},
}));

import { getFullGraph } from '@/lib/graphStore';
import { searchLocalIndex, searchLocalIndexMany } from '@/lib/localSearch';
import { GET } from '@/app/api/finra/graph-search/route';

describe('graph-search route', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
		vi.mocked(searchLocalIndex).mockClear();
		vi.mocked(searchLocalIndexMany).mockClear();
		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: 'person:1222513',
					label: 'Ronald Perry Mason',
					group: 'individual',
					crd: '1222513',
				},
				{
					id: 'person:999999',
					label: 'Randy Mayson',
					group: 'individual',
					crd: '999999',
				},
				{
					id: 'firm:39914',
					label: 'Mason Example Firm',
					group: 'firm',
					firmId: '39914',
				},
			],
			links: [],
		});
	});

	it('matches free-text node names like mason', async () => {
		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=mason'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toContain('person:1222513');
		expect(payload.matchedIds).toContain('firm:39914');
		expect(payload.matchedIds).not.toContain('person:999999');
		expect(payload.nodes.some((node: any) => node.id === 'person:1222513')).toBe(true);
		expect(payload.nodes.some((node: any) => node.id === 'firm:39914')).toBe(true);
	});

	it('matches top-level CRDs only', async () => {
		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=1222513'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toEqual(['person:1222513']);
		expect(payload.nodes.some((node: any) => node.id === 'person:1222513')).toBe(true);
	});

	it('caps fallback page fetches at 200 results and honors the start offset', async () => {
		vi.mocked(getFullGraph).mockResolvedValueOnce({ nodes: [], links: [] });
		await GET(new NextRequest('http://localhost/api/finra/graph-search?q=abc123&limit=999&start=200'));

		expect(vi.mocked(searchLocalIndexMany)).toHaveBeenCalled();
		for (const call of vi.mocked(searchLocalIndexMany).mock.calls) {
			expect(call[3]).toMatchObject({ limit: 200, offset: 200 });
		}
	});

	it('matches graph-search queries against address text', async () => {
		vi.mocked(getFullGraph).mockResolvedValueOnce({
			nodes: [
				{ id: 'person:1', label: 'Alice Example', group: 'individual', crd: '1', addressSearchText: '10 king street melbourne australia' },
				{ id: 'person:2', label: 'Bob Example', group: 'individual', crd: '2', addressSearchText: '100 george street sydney australia' },
			],
			links: [],
		});
		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=Sydney'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toEqual(['person:2']);
		expect(payload.nodes.some((node: any) => node.id === 'person:1')).toBe(false);
		expect(payload.nodes.some((node: any) => node.id === 'person:2')).toBe(true);
	});

	it('hydrates numeric CRD via direct detail fallback when local index has no hits', async () => {
		vi.mocked(getFullGraph).mockResolvedValueOnce({ nodes: [], links: [] });
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.includes('/api/finra/individual/8164723')) {
				return {
					ok: true,
					json: async () => ({
						found: true,
						merged: {
							basicInformation: {
								individualId: '8164723',
								firstName: 'TEST',
								lastName: 'PERSON',
							},
							currentEmployments: [{ firm_id: '12345', firm_name: 'Fallback Firm' }],
						},
					}),
				} as any;
			}
			if (url.includes('/api/finra/firm/8164723')) {
				return {
					ok: true,
					json: async () => ({ found: false }),
				} as any;
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		global.fetch = fetchMock as any;

		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=8164723'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toContain('person:8164723');
		expect(payload.nodes.some((node: any) => node.id === 'person:8164723')).toBe(true);
		expect(payload.nodes.some((node: any) => node.id === 'firm:12345')).toBe(true);
		expect(fetchMock).toHaveBeenCalled();
	});

	it('hydrates numeric CRD via cache-card fallback when detail routes return found:false', async () => {
		vi.mocked(getFullGraph).mockResolvedValueOnce({ nodes: [], links: [] });
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.includes('/api/finra/individual/8164723')) {
				return { ok: true, json: async () => ({ found: false }) } as any;
			}
			if (url.includes('/api/finra/firm/8164723')) {
				return { ok: true, json: async () => ({ found: false }) } as any;
			}
			if (url.includes('/api/dashboard/refresh')) {
				return {
					ok: true,
					json: async () => ({
						ok: true,
						cards: [
							{
								id: '8164723',
								entity: 'individual',
								files: 2,
								sources: [
									{ source: 'finra', status: 'ok' },
									{ source: 'sec', status: 'ok' },
								],
							},
						],
					}),
				} as any;
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		global.fetch = fetchMock as any;

		const response = await GET(new NextRequest('http://localhost/api/finra/graph-search?q=8164723'));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.matchedIds).toContain('person:8164723');
		expect(payload.nodes.some((node: any) => node.id === 'person:8164723')).toBe(true);
		expect(payload.nodes.some((node: any) => node._source === 'cache-card-fallback')).toBe(true);
		expect(fetchMock).toHaveBeenCalled();
	});
});
