import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getFirmConnectionsFromGraph } = vi.hoisted(() => ({
	getFirmConnectionsFromGraph: vi.fn(async (_id: string) => ({
		currentConnections: [
			{
				individualId: '1001',
				name: 'John Doe',
				relationship: 'Registered Representative',
				isCurrent: true,
			},
		],
		previousConnections: [
			{
				individualId: '1002',
				name: 'Jane Smith',
				relationship: 'Previous Representative',
				isCurrent: false,
			},
		],
	})),
}));

vi.mock('@/lib/graphConnections', () => ({
	getFirmConnectionsFromGraph,
}));

import { GET as getConnections } from '../../src/app/api/finra/firm/[id]/connections/route';
import { GET as getFirm } from '../../src/app/api/finra/firm/[id]/route';

vi.mock('@/lib/cache', () => ({
	redis: {
		get: vi.fn(async () => null),
		set: vi.fn(async () => 'OK'),
	},
	getFromCache: vi.fn(async () => null),
	saveToCache: vi.fn(async () => {}),
}));

describe('firm connections route and deferConnections option', () => {
	it('returns firm connections from /api/finra/firm/[id]/connections', async () => {
		const request = new NextRequest('http://localhost:3000/api/finra/firm/13686/connections');
		const response = await getConnections(request, { params: Promise.resolve({ id: '13686' }) });
		expect(response.status).toBe(200);

		const data = await response.json();
		expect(data.found).toBe(true);
		expect(data.firmId).toBe('13686');
		expect(data.currentConnections).toHaveLength(1);
		expect(data.currentConnections[0].name).toBe('John Doe');
		expect(data.previousConnections).toHaveLength(1);
		expect(data.previousConnections[0].name).toBe('Jane Smith');
		expect(response.headers.get('cache-control')).toContain('s-maxage=60');
	});

	it('passes skipEnrichment when light=1', async () => {
		getFirmConnectionsFromGraph.mockClear();
		const request = new NextRequest('http://localhost:3000/api/finra/firm/13686/connections?light=1');
		const response = await getConnections(request, { params: Promise.resolve({ id: '13686' }) });
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.light).toBe(true);
		expect(getFirmConnectionsFromGraph).toHaveBeenCalledWith('13686', { skipEnrichment: true });
	});

	it('handles invalid firm id gracefully', async () => {
		const request = new NextRequest('http://localhost:3000/api/finra/firm/abc/connections');
		const response = await getConnections(request, { params: Promise.resolve({ id: 'abc' }) });
		expect(response.status).toBe(400);
	});
});
