import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, saveGraph } from '@/lib/graphStore';

export async function POST(req: NextRequest) {
	try {
		const graph = await getFullGraph();
		const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
		const links = Array.isArray(graph.links) ? graph.links : [];
		// Deduplicate individuals and firms across FINRA and SEC
		const uniqueIndividuals = new Set(nodes.filter((n) => n.group === 'individual' || String(n.id || '').startsWith('person:')).map((n) => n.id));
		const uniqueFirms = new Set(nodes.filter((n) => n.group === 'firm' || String(n.id || '').startsWith('firm:')).map((n) => n.id));

		const totalIndividuals = uniqueIndividuals.size;
		const totalFirms = uniqueFirms.size;
		const totalEntities = nodes.filter((n) => n.group === 'entity').length;
		const totalLinks = links.length;
		graph.meta = { ...(graph.meta || {}), generated: new Date().toISOString(), totalIndividuals, totalFirms, totalEntities, totalNodes: nodes.length, totalLinks };
		await saveGraph(graph);
		return NextResponse.json({ ok: true, meta: graph.meta });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
