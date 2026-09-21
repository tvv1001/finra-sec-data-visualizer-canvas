import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/finra-graph-defaults', () => ({
	DEFAULT_EXPANSION_HOPS: 2,
}));

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
	getSeedBankFromStore: vi.fn(),
	toCompactNode: vi.fn((node) => node),
}));

vi.mock('@/lib/seedStore', () => ({
	getProfilesFromStore: vi.fn(),
}));

vi.mock('@/lib/peopleClusterCache', () => ({
	tryLoadPersonCluster: vi.fn(async () => null),
}));

import { GET } from '@/app/api/finra/graph/route';
import { getFullGraph, getSeedBankFromStore } from '@/lib/graphStore';

describe('graph route default expansion hops', () => {
	beforeEach(() => {
		vi.mocked(getSeedBankFromStore).mockResolvedValue({
			individualIds: ['person:1'],
			firmIds: [],
			entityIds: [],
			otherIds: [],
			allNodeIds: ['person:1'],
			nameByNumber: { individual: {}, firm: {} },
			counts: { individuals: 1, firms: 0, entities: 0, others: 0, totalNodes: 1 },
			updatedAt: new Date().toISOString(),
		});

		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: 'person:1',
					label: 'Seed Person',
					group: 'individual',
					currentEmployments: [{ firmId: '2' }],
				},
				{
					id: 'firm:2',
					label: 'Bridge Firm',
					group: 'firm',
					bcScope: 'Active',
				},
				{
					id: 'person:3',
					label: 'Second Hop Person',
					group: 'individual',
					currentEmployments: [{ firmId: '2' }],
				},
			],
			links: [
				{ source: 'person:1', target: 'firm:2', relationship: 'employed_by' },
				{ source: 'firm:2', target: 'person:3', relationship: 'controls' },
			],
			meta: {
				totalNodes: 3,
				totalLinks: 2,
			},
		});
	});

	it('uses DEFAULT_EXPANSION_HOPS for limited initial graph loads', async () => {
		const response = await GET(new NextRequest('http://localhost/api/finra/graph?limit=1'));
		const payload = await response.json();
		const nodeIds = payload.nodes.map((node: { id: string }) => node.id);

		expect(response.status).toBe(200);
		expect(nodeIds).toEqual(expect.arrayContaining(['person:1', 'firm:2', 'person:3']));
		expect(payload.links).toHaveLength(2);
	});
});
