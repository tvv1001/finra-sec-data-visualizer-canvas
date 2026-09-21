import { NextResponse } from 'next/server';
import { getFullGraph, getSeedBankFromStore, invalidateGraphCache } from '@/lib/graphStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
	invalidateGraphCache();
	const [graph, seedBank] = await Promise.all([getFullGraph(), getSeedBankFromStore()]);
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const links: any[] = Array.isArray(graph?.links) ? graph.links : [];

	const linkCount = links.length;

	return NextResponse.json(
		{
			ok: true,
			counts: {
				people: seedBank.counts.individuals,
				firms: seedBank.counts.firms,
				entities: seedBank.counts.entities,
				otherNodes: seedBank.counts.others,
				totalNodes: seedBank.counts.totalNodes || nodes.length,
				links: linkCount,
			},
			seedBankUpdatedAt: seedBank.updatedAt,
			ts: new Date().toISOString(),
		},
		{
			headers: {
				'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			},
		},
	);
}
