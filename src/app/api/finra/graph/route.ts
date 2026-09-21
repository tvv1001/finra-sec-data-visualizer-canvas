import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, getSeedBankFromStore, toCompactNode } from '@/lib/graphStore';
import { getProfilesFromStore } from '@/lib/seedStore';
import { DEFAULT_EXPANSION_HOPS } from '@/lib/finra-graph-defaults';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { tryLoadPersonCluster } from '@/lib/peopleClusterCache';

let cachedGraphRouteKey = '';
let cachedGraphAdj: Map<string, string[]> | null = null;

function getGraphRouteCacheKey(graph: any) {
	return `${String(graph?.meta?.generated || '')}|${Number(graph?.nodes?.length || 0)}|${Number(graph?.links?.length || 0)}`;
}

function refreshGraphRouteCaches(graph: any) {
	const key = getGraphRouteCacheKey(graph);
	if (cachedGraphRouteKey === key && cachedGraphAdj) {
		return { adj: cachedGraphAdj };
	}

	const adj = new Map<string, string[]>();
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const links: any[] = Array.isArray(graph?.links) ? graph.links : [];

	nodes.forEach((node) => {
		const id = String(node?.id || '').trim();
		if (id) adj.set(id, []);
	});
	for (const l of links) {
		const s = String((l.source?.id ?? l.source) || '').trim();
		const t = String((l.target?.id ?? l.target) || '').trim();
		if (!s || !t) continue;
		if (!adj.has(s)) adj.set(s, []);
		if (!adj.has(t)) adj.set(t, []);
		adj.get(s)!.push(t);
		adj.get(t)!.push(s);
	}

	cachedGraphRouteKey = key;
	cachedGraphAdj = adj;
	return { adj };
}

function normalizeStatusString(value: unknown) {
	return String(value || '')
		.toLowerCase()
		.trim();
}

function hasActiveStatus(value: unknown) {
	const normalized = normalizeStatusString(value);
	if (!normalized) return false;
	const activePattern = /\b(active|approved|current|valid|licensed|registered|effective)\b/;
	const inactivePattern = /\b(inactive|terminated|revoked|suspended|withdrawn|expired|ceased|closed|not\s*active|not\s*in\s*scope|previous)\b/;
	return activePattern.test(normalized) && !inactivePattern.test(normalized);
}

function getNodeNumericValue(node: any) {
	const id = String(node?.id || '').trim();
	const match = id.match(/(?:person|firm)[:_]?([0-9]+)$/);
	return match ? Number(match[1]) : 0;
}

function collectActiveConnectedIds(adj: Map<string, string[]>, nodes: any[]) {
	const activeIds = new Set<string>();
	for (const node of nodes) {
		if (!node || typeof node !== 'object') continue;
		const id = String(node?.id || '').trim();
		if (!id) continue;

		if (node.group === 'firm') {
			if (
				hasActiveStatus(node.bcScope) ||
				hasActiveStatus(node.basicInformation?.bcScope) ||
				hasActiveStatus(node.firmStatus) ||
				hasActiveStatus(node.basicInformation?.firmStatus) ||
				hasActiveStatus(node.iaScope) ||
				hasActiveStatus(node.basicInformation?.iaScope) ||
				(Array.isArray(node.activeStates) && node.activeStates.length > 0)
			) {
				activeIds.add(id);
			}
		} else if (node.group === 'individual') {
			if (
				hasActiveStatus(node.bcScope) ||
				hasActiveStatus(node.basicInformation?.bcScope) ||
				hasActiveStatus(node.iaScope) ||
				hasActiveStatus(node.basicInformation?.iaScope) ||
				(Array.isArray(node.currentEmployments) && node.currentEmployments.length > 0) ||
				(Array.isArray(node.currentIAEmployments) && node.currentIAEmployments.length > 0) ||
				(Array.isArray(node.activeStates) && node.activeStates.length > 0) ||
				Number(node?.registrationCount?.approvedFinraRegistrationCount || 0) > 0 ||
				Number(node?.registrationCount?.approvedSRORegistrationCount || 0) > 0 ||
				Number(node?.registrationCount?.approvedStateRegistrationCount || 0) > 0 ||
				Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0
			) {
				activeIds.add(id);
			}
		}
	}

	if (!activeIds.size) return new Set<string>(activeIds);

	const visited = new Set<string>(activeIds);
	const queue = Array.from(activeIds);
	while (queue.length) {
		const current = queue.shift();
		if (!current) continue;
		for (const neighbor of adj.get(current) || []) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
	}

	return visited;
}

async function sampleNodesFromSeedBank(nodes: any[], limit: number, graphAdj: Map<string, string[]>) {
	try {
		const seedBank = await getSeedBankFromStore();
		const nodeMap = new Map(nodes.map((n) => [String(n?.id || '').trim(), n]));
		const activeConnectedIds = collectActiveConnectedIds(graphAdj, nodes);
		const candidateIds = [...(seedBank?.individualIds || []), ...(seedBank?.firmIds || [])].filter((id) => nodeMap.has(id));

		const scored = candidateIds
			.map((id) => {
				const node = nodeMap.get(id)!;
				return {
					id,
					node,
					numeric: getNodeNumericValue(node),
					degree: graphAdj.get(id)?.length ?? 0,
					activeConnected: activeConnectedIds.has(id),
				};
			})
			.filter((item) => item.activeConnected || activeConnectedIds.size === 0);

		scored.sort((a, b) => {
			if (a.activeConnected !== b.activeConnected) return a.activeConnected ? -1 : 1;
			if (a.numeric !== b.numeric) return b.numeric - a.numeric;
			if (a.degree !== b.degree) return b.degree - a.degree;
			return String(a.id).localeCompare(String(b.id));
		});

		const selected = scored.slice(0, limit).map((entry) => entry.node);
		if (selected.length >= limit) return selected;

		const selectedIds = new Set(selected.map((node) => String(node.id || '').trim()));
		const fallback = candidateIds
			.filter((id) => !selectedIds.has(id))
			.map((id) => {
				const node = nodeMap.get(id)!;
				return {
					id,
					node,
					numeric: getNodeNumericValue(node),
					degree: graphAdj.get(id)?.length ?? 0,
				};
			})
			.sort((a, b) => b.numeric - a.numeric || b.degree - a.degree || String(a.id).localeCompare(String(b.id)))
			.slice(0, limit - selected.length)
			.map((entry) => entry.node);

		return [...selected, ...fallback];
	} catch {
		return sampleNodesRandomly(nodes, limit);
	}
}

function sampleNodesRandomly(nodes: any[], limit: number) {
	const count = Math.max(0, Math.min(limit, nodes.length));
	const sampled = nodes.slice();
	for (let i = sampled.length - 1; i > sampled.length - 1 - count; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[sampled[i], sampled[j]] = [sampled[j], sampled[i]];
	}
	return sampled.slice(sampled.length - count);
}

async function getProfilesData() {
	return getProfilesFromStore();
}

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const limit = parseInt(searchParams.get('limit') ?? '0', 10);
	const profileName = searchParams.get('profile') ?? undefined;

	if (limit > 0) {
		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const links: any[] = graph.links || [];
		const { adj: cachedAdj } = refreshGraphRouteCaches(graph);

		// Select seeds from the seed bank for a more deterministic and interesting initial subset.
		const seeds: any[] = await sampleNodesFromSeedBank(nodes, limit, cachedAdj);
		const seedIds = new Set(seeds.map((n) => String(n.id || '').trim()));

		if (seeds.length === 1 && String(seeds[0]?.group || '').trim() === 'individual') {
			try {
				const cluster = await tryLoadPersonCluster(String(seeds[0].id || '').replace(/^person:/, ''));
				if (cluster) {
					return NextResponse.json(
						{
							nodes: Array.isArray(cluster.nodes) ? cluster.nodes.map(toCompactNode) : [],
							links: cluster.links || [],
							meta: {
								...(graph.meta || {}),
								subset: true,
								subsetSize: cluster.people?.length || seeds.length,
								totalNodes: nodes.length,
								totalLinks: links.length,
								sourceLabel: 'people-cluster',
								clusterId: cluster.clusterId,
							},
						},
						{ headers: sharedCacheHeaders(120) },
					);
				}
			} catch (error) {
				console.warn('graph route people-cluster lookup failed; falling back to graph BFS', error);
			}
		}

		if (profileName) {
			const pr = await getProfilesData();
			if (Array.isArray(pr.profiles)) {
				const prof = pr.profiles.find((p: any) => p.name === profileName);
				if (prof) {
					const profileIds = [...(prof.individuals || []).map((crd: number) => `person:${crd}`), ...(prof.firms || []).map((crd: number) => `firm:${crd}`)];
					for (const id of profileIds) {
						const node = nodes.find((n) => n.id === id);
						if (node && !seedIds.has(id)) {
							seeds.push(node);
							seedIds.add(id);
						}
					}
				}
			}
		}

		const neighborIds = new Set(seedIds);
		const graphAdj = cachedAdj || new Map<string, string[]>();
		// Respect the shared graph default instead of silently pinning initial load to 1 hop.
		const initialLoadHops = Math.max(1, Math.floor(Number(DEFAULT_EXPANSION_HOPS) || 1));
		let frontier = new Set(seedIds);
		for (let h = 0; h < initialLoadHops; h++) {
			const next = new Set<string>();
			for (const id of frontier) {
				for (const nid of graphAdj.get(id) || []) {
					if (!neighborIds.has(nid)) {
						neighborIds.add(nid);
						next.add(nid);
					}
				}
			}
			frontier = next;
			if (frontier.size === 0) break;
		}

		return NextResponse.json(
			{
				nodes: nodes.filter((n) => neighborIds.has(n.id)).map(toCompactNode),
				links: links.filter((l) => {
					const s = l.source?.id ?? l.source;
					const t = l.target?.id ?? l.target;
					return neighborIds.has(s) && neighborIds.has(t);
				}),
				meta: {
					...(graph.meta || {}),
					subset: true,
					subsetSize: seeds.length,
					totalNodes: nodes.length,
					totalLinks: links.length,
				},
			},
			{ headers: sharedCacheHeaders(120) },
		);
	}

	if (profileName === 'custom') {
		return NextResponse.json(
			{
				nodes: [],
				links: [],
				meta: {
					sourceLabel: '(custom profile starts empty)',
					generated: new Date().toISOString(),
					totalIndividuals: 0,
					totalFirms: 0,
					totalEntities: 0,
					totalNodes: 0,
					totalLinks: 0,
				},
			},
			{ headers: sharedCacheHeaders(120) },
		);
	}

	// Return full graph from store (Redis on Vercel, filesystem locally)
	const graph = await getFullGraph();
	return NextResponse.json(
		{
			...graph,
			nodes: Array.isArray(graph?.nodes) ? graph.nodes.map(toCompactNode) : [],
		},
		{ headers: sharedCacheHeaders(120) },
	);
}
