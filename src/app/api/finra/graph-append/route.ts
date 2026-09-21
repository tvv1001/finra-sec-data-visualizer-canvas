import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, graphFileExists, saveGraph, setGraphCacheWarm, _graphCache } from '@/lib/graphStore';
import { logger } from '@/lib/logger';
import { stripSimState } from '@/lib/graphStore';
import { mergeGraphNodesForAppend, rewriteGraphLinksForNodeIdentity } from '@/lib/graphIdentity';

// Serialize durable saves so concurrent appends do not stampede Redis/disk and
// wedge the Next.js event loop on large national graphs.
let durableSaveChain: Promise<void> = Promise.resolve();

function enqueueDurableSave(merged: any) {
	durableSaveChain = durableSaveChain
		.then(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			await saveGraph(merged);
		})
		.catch((error) => {
			logger.warn('graph-append background save failed', { error: error?.message || String(error) });
		});
}

export async function POST(request: NextRequest) {
	const t0 = performance.now();
	try {
		const { nodes: newNodes = [], links: newLinks = [] } = await request.json();
		if (!Array.isArray(newNodes) || !Array.isArray(newLinks)) {
			return NextResponse.json({ error: 'nodes and links must be arrays' }, { status: 400 });
		}

		// Local/dev: merging into the national ~80k-node graph on every interactive
		// append blocks the Next event loop (search/health freeze). The browser
		// session already holds the nodes; skip durable national-graph merge here.
		const localRedis = process.env.USE_LOCAL_REDIS === '1' || process.env.USE_LOCAL_REDIS === 'true';
		const warmCount = Array.isArray(_graphCache?.nodes) ? _graphCache.nodes.length : 0;
		if (localRedis && warmCount > 10_000) {
			console.log('[graph-append] skip national merge (local large graph)', {
				warmCount,
				incomingNodes: newNodes.length,
				incomingLinks: newLinks.length,
				ms: performance.now() - t0,
			});
			return NextResponse.json({
				ok: true,
				addedNodes: 0,
				addedLinks: 0,
				skippedMerge: true,
				reason: 'local-large-graph',
			});
		}

		let graph: any;
		const t1 = performance.now();
		console.log('[graph-append] parse JSON:', t1 - t0);
		// Prefer warm in-memory graph to avoid reloading ~80k nodes per append.
		if (_graphCache?.nodes) {
			graph = _graphCache;
		} else {
			const exists = await graphFileExists();
			graph = exists ? await getFullGraph() : { nodes: [], links: [], meta: { generated: new Date().toISOString() } };
		}

		const existingNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
		const t2 = performance.now();
		console.log('[graph-append] getFullGraph:', t2 - t1);
		const mergeResult = mergeGraphNodesForAppend(
			existingNodes,
			newNodes.map((node) => stripSimState(node)),
		);
		const mergedNodes = mergeResult.nodes;
		// O(n) membership — nested .some() was O(merged*existing) and blocked Next.
		const existingIdSet = new Set(existingNodes.map((node) => node?.id).filter(Boolean));
		let added = 0;
		for (const node of mergedNodes) {
			if (node?.id && !existingIdSet.has(node.id)) added += 1;
		}
		const canonicalNodeIds = new Set(mergedNodes.map((node) => node.id));
		const linkKey = (l: any) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			return `${s}|${t}`;
		};
		const existingLinks = new Set((Array.isArray(graph.links) ? graph.links : []).map(linkKey));
		const t3 = performance.now();
		console.log('[graph-append] mergeGraphNodes:', t3 - t2);
		const rewrittenIncomingLinks = rewriteGraphLinksForNodeIdentity(newLinks, mergeResult.idRewriteMap);
		const addedLinks: any[] = [];
		for (const l of rewrittenIncomingLinks) {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			if (canonicalNodeIds.has(s) && canonicalNodeIds.has(t) && !existingLinks.has(linkKey(l))) {
				addedLinks.push({
					source: s,
					target: t,
					type: l.type,
					relationship: l.relationship,
					isCurrent: l.isCurrent,
					startDate: l.startDate,
					endDate: l.endDate,
				});
			}
		}

		const mergedLinks = [...(Array.isArray(graph.links) ? graph.links : []), ...addedLinks];

		const totalIndividuals = mergedNodes.filter((n) => n.group === 'individual').length;
		const totalFirms = mergedNodes.filter((n) => n.group === 'firm').length;
		const totalEntities = mergedNodes.filter((n) => n.group === 'entity').length;
		const totalLinks = mergedLinks.length;

		const merged = {
			...graph,
			nodes: mergedNodes,
			links: mergedLinks,
			meta: {
				...(graph.meta || {}),
				generated: new Date().toISOString(),
				totalIndividuals,
				totalFirms,
				totalEntities,
				totalNodes: mergedNodes.length,
				totalLinks,
			},
		};

		const t4 = performance.now();
		console.log('[graph-append] build Merged:', t4 - t3);

		// Keep process memory warm immediately; durable Redis/disk write is deferred so
		// interactive search/health stay responsive on localhost.
		setGraphCacheWarm(merged);
		enqueueDurableSave(merged);

		return NextResponse.json({ ok: true, addedNodes: added, addedLinks: addedLinks.length, deferredSave: true });
	} catch (err: any) {
		logger.error('graph-append error', { error: err.message });
		return NextResponse.json({ error: 'Failed to append to graph.' }, { status: 500 });
	}
}
