import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, toCompactNode } from '@/lib/graphStore';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
	try {
		const ids = (new URL(request.url).searchParams.get('ids') || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!ids.length) return NextResponse.json([]);
		const graph = await getFullGraph();
		const idSet = new Set(ids);
		return NextResponse.json(
			(graph.nodes || []).filter((n: any) => idSet.has(n.id)).map(toCompactNode),
		);
	} catch (err: any) {
		logger.error('nodes-by-ids error', { error: err.message });
		return NextResponse.json({ error: 'Failed to fetch nodes by ids.' }, { status: 500 });
	}
}
