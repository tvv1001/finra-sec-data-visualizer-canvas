import { NextRequest, NextResponse } from 'next/server';
import { getFullGraph, saveGraph } from '@/lib/graphStore';
import { Redis as UpstashRedis } from '@upstash/redis';
import { logger } from '@/lib/logger';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { extractSearchQueries, hydrateGraphNodesFromSearchSidecar, searchLocalIndexMany } from '@/lib/localSearch';
import { normalizeIndividualDetailFromSource } from '@/lib/individualDetail';
import { resolveIndividualSourceDetail } from '@/lib/sourceTruth';
import { tryLoadPersonCluster } from '@/lib/peopleClusterCache';
import { matchesSearchableNodeQuery } from '@/lib/searchGraphFallback';
import { searchExternalFallback } from '@/lib/searchExternalFallback';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function hasStringContent(hit: unknown): hit is { content: string } {
	return typeof hit === 'object' && hit !== null && typeof (hit as any).content === 'string';
}

function buildNodesFromIndividualDetail(detail: any, crd: string) {
	const merged = detail?.merged || detail?.finraNode || detail || {};
	const basic = merged?.basicInformation || {};
	const personId = `person:${crd}`;
	const label = [basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' ') || basic?.name || merged?.name || `CRD ${crd}`;

	const nodes: any[] = [
		{
			id: personId,
			label,
			group: 'individual',
			crd,
			_source: 'direct-crd-fallback',
			basicInformation: basic || null,
			bcScope: merged?.bcScope ?? basic?.bcScope ?? null,
			iaScope: merged?.iaScope ?? basic?.iaScope ?? null,
			currentEmployments: Array.isArray(merged?.currentEmployments) ? merged.currentEmployments : [],
			previousEmployments: Array.isArray(merged?.previousEmployments) ? merged.previousEmployments : [],
			currentIAEmployments: Array.isArray(merged?.currentIAEmployments) ? merged.currentIAEmployments : [],
			previousIAEmployments: Array.isArray(merged?.previousIAEmployments) ? merged.previousIAEmployments : [],
			registrationCount: merged?.registrationCount || null,
		},
	];

	const links: any[] = [];
	const seenFirmIds = new Set<string>();
	const employments = [
		...(Array.isArray(merged?.currentEmployments) ? merged.currentEmployments : []),
		...(Array.isArray(merged?.previousEmployments) ? merged.previousEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
		...(Array.isArray(merged?.currentIAEmployments) ? merged.currentIAEmployments : []),
		...(Array.isArray(merged?.previousIAEmployments) ? merged.previousIAEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
	];

	for (const employment of employments) {
		const firmId = String(employment?.firm_id || employment?.firmId || employment?.firmIdNumber || '').trim();
		if (!firmId) continue;
		const firmNodeId = `firm:${firmId}`;
		if (!seenFirmIds.has(firmNodeId)) {
			seenFirmIds.add(firmNodeId);
			nodes.push({
				id: firmNodeId,
				label: employment?.firm_name || employment?.firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId,
				_source: 'direct-crd-fallback',
			});
		}
		links.push({
			source: personId,
			target: firmNodeId,
			relationship: employment?._isCurrent === false ? 'previous_employed_by' : 'employed_by',
			isCurrent: employment?._isCurrent !== false,
		});
	}

	return { nodes, links, matchedIds: [personId] };
}

function buildNodesFromFirmDetail(detail: any, id: string) {
	const merged = detail?.merged || detail?.finraNode || detail || {};
	const basic = merged?.basicInformation || {};
	const firmNodeId = `firm:${id}`;
	const nodes: any[] = [
		{
			id: firmNodeId,
			label: basic?.firmName || merged?.firmName || merged?.name || `Firm ${id}`,
			group: 'firm',
			firmId: id,
			_source: 'direct-crd-fallback',
			firmStatus: merged?.firmStatus || basic?.firmStatus || null,
			bcScope: merged?.bcScope || basic?.bcScope || null,
			iaScope: merged?.iaScope || basic?.iaScope || null,
			isLegacy: merged?.isLegacy || basic?.isLegacy || null,
		},
	];

	const links: any[] = [];
	const owners = Array.isArray(merged?.directOwners) ? merged.directOwners : [];
	for (const owner of owners) {
		const ownerCrd = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
		if (!ownerCrd) continue;
		const personId = `person:${ownerCrd}`;
		nodes.push({
			id: personId,
			label: owner?.legalName || owner?.name || `Person ${ownerCrd}`,
			group: 'individual',
			crd: ownerCrd,
			_source: 'direct-crd-fallback',
			stub: true,
		});
		links.push({ source: personId, target: firmNodeId, relationship: 'controls' });
	}

	return { nodes, links, matchedIds: [firmNodeId] };
}

async function persistGraphSearchNodesAndLinks(newNodes: any[], newLinks: any[]) {
	try {
		await hydrateGraphNodesFromSearchSidecar(newNodes);
		const graph = await getFullGraph();
		const existingIds = new Set((graph.nodes || []).map((node: any) => String(node.id)));
		const addedNodeIds: string[] = [];

		for (const node of newNodes) {
			if (!existingIds.has(node.id)) {
				graph.nodes.push(node);
				addedNodeIds.push(node.id);
			}
		}
		for (const link of newLinks) graph.links.push(link);
		await saveGraph(graph);

		try {
			const { canWriteToRedis } = await import('@/lib/redisAvailability');
			if (!canWriteToRedis()) {
				// skip telemetry writes when Redis writes are off or cache-only
			} else {
				// prefer MIRROR env var but fall back to legacy _2 names
				const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
				const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
				if (url && token) {
					const redis = new UpstashRedis({ url, token });
					const ts = new Date().toISOString();
					const entry = {
						ts,
						action: 'persist-local-search-hits',
						source: 'graph-search',
						added: addedNodeIds.length,
						sample: addedNodeIds.slice(0, 5),
					};
					await redis.lpush('finra:redis-monitor', JSON.stringify(entry));
					await redis.ltrim('finra:redis-monitor', 0, 199);
				}
			}
		} catch {
			// ignore monitor failures
		}
	} catch {
		// ignore persistence errors but continue returning nodes
	}
}

async function fetchCacheCardsFallback(baseUrl: string, crd: string) {
	try {
		const response = await fetch(`${baseUrl}/api/dashboard/refresh`, {
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'list-cache-cards',
				maxCards: 200,
				crdFilter: crd,
			}),
			cache: 'no-store',
		});

		if (!response.ok) return [] as any[];
		const payload = await response.json().catch(() => null);
		const cards = Array.isArray(payload?.cards) ? payload.cards : [];
		return cards.filter((card: any) => String(card?.id || '').trim() === crd);
	} catch {
		return [] as any[];
	}
}

function buildNodesFromCacheCards(cards: any[], type: string) {
	const nodes: any[] = [];
	const links: any[] = [];
	const matchedIds: string[] = [];
	const seen = new Set<string>();

	for (const card of cards) {
		const id = String(card?.id || '').trim();
		const entity = String(card?.entity || '')
			.trim()
			.toLowerCase();
		if (!/^\d{1,10}$/.test(id)) continue;
		if (entity !== 'individual' && entity !== 'firm') continue;
		if (type !== 'all' && type !== entity) continue;

		const nodeId = entity === 'individual' ? `person:${id}` : `firm:${id}`;
		if (seen.has(nodeId)) continue;
		seen.add(nodeId);
		matchedIds.push(nodeId);

		nodes.push({
			id: nodeId,
			label: entity === 'individual' ? `CRD ${id}` : `Firm ${id}`,
			group: entity === 'individual' ? 'individual' : 'firm',
			...(entity === 'individual' ? { crd: id } : { firmId: id }),
			_source: 'cache-card-fallback',
			sources: Array.isArray(card?.sources) ? card.sources : [],
		});
	}

	return { nodes, links, matchedIds };
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const rawQ = (searchParams.get('q') || '').trim();
		const searchQueries = extractSearchQueries(rawQ)
			.map((query) => query.toLowerCase())
			.filter(Boolean);
		const q = searchQueries[0] || '';
		const baseUrl = new URL(request.url).origin;
		const type = searchParams.get('type') || 'all';
		const limit = Math.min(parseInt(searchParams.get('limit') || searchParams.get('nrows') || '50', 10), 200);
		const rawStart = searchParams.get('start');
		const rawPageNumber = searchParams.get('pageNumber');
		const offset =
			rawStart != null ? Math.max(0, Number.parseInt(rawStart, 10) || 0)
			: rawPageNumber != null ? Math.max(0, (Math.max(1, Number.parseInt(rawPageNumber, 10) || 1) - 1) * limit)
			: 0;

		if (!q) return NextResponse.json({ nodes: [], links: [], matchedIds: [] });

		const graph = await getFullGraph();
		const nodes: any[] = graph.nodes || [];
		const matchedNodes = nodes
			.filter((node) => {
				if (type !== 'all' && node.group !== type) return false;
				return searchQueries.length > 0 ? searchQueries.some((query) => matchesSearchableNodeQuery(node, query)) : matchesSearchableNodeQuery(node, q);
			})
			.slice(0, limit);
		const matchedIds = new Set(matchedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

		const isIdentifierLike = /^[0-9-]+$/.test(q);
		const isSpecificQuery = isIdentifierLike || q.split(/\s+/).filter(Boolean).length > 1;

		if (matchedIds.size === 1 && isSpecificQuery) {
			const matchedNode = matchedNodes[0];
			const matchedId = String(matchedNode?.id || '').trim();
			if (matchedNode && matchedNode.group === 'individual' && matchedId.startsWith('person:')) {
				try {
					const cluster = await tryLoadPersonCluster(matchedId.slice('person:'.length));
					if (cluster) {
						return NextResponse.json(
							{
								nodes: cluster.nodes || [],
								links: cluster.links || [],
								matchedIds: [matchedId],
								meta: {
									sourceLabel: 'people-cluster',
									clusterId: cluster.clusterId,
									clusterSize: cluster.people?.length || 0,
								},
							},
							{ headers: sharedCacheHeaders(300) },
						);
					}
				} catch (error) {
					console.warn('graph-search people-cluster lookup failed; continuing with graph results', error);
				}
			}
		}

		if (matchedIds.size === 0) {
			// Not enough graph matches — search the local FINRA/SEC indexes and persist discovered nodes into the graph cache.
			try {
				let allHits: any[] = [];
				let skipLocalIndexSearch = false;

				// Fast-path numeric CRDs using the combined inventory sidecar.
				// This skips the slow full-text search across 4 sidecars and immediately
				// resolves the node if it exists in the merged FINRA+SEC list.
				if (/^\d{1,10}$/.test(q)) {
					const { isCrdInInventory } = await import('@/lib/crdInventorySidecar');
					const inv = isCrdInInventory(q);
					if (inv.isFirm || inv.isIndividual) {
						skipLocalIndexSearch = true;
					}
				}

				if (!skipLocalIndexSearch) {
					// Per-query limit so comma-separated name lists don't starve later terms.
					const perQueryLimit = Math.max(12, Math.ceil(limit / Math.max(1, searchQueries.length)));
					const mergedHits: any[] = [];
					const seenHitIds = new Set<string>();
					for (const sq of searchQueries) {
						const bucketHits = (
							await Promise.all([
								searchLocalIndexMany('finra', 'individual', sq, { limit: perQueryLimit, offset, baseUrl }),
								searchLocalIndexMany('finra', 'firm', sq, { limit: perQueryLimit, offset, baseUrl }),
								searchLocalIndexMany('sec', 'individual', sq, { limit: perQueryLimit, offset, baseUrl }),
								searchLocalIndexMany('sec', 'firm', sq, { limit: perQueryLimit, offset, baseUrl }),
							])
						).flatMap((result) => result?.hits?.hits || []);
						for (const hit of bucketHits) {
							const source = hit?._source || (hit as any);
							const hitId = String(
								hit?._id || source?.ind_source_id || source?.ind_crd || source?.firm_id || source?.firmId || source?.firm_source_id || '',
							).trim();
							const dedupeKey = hitId || JSON.stringify(source || {}).slice(0, 120);
							if (seenHitIds.has(dedupeKey)) continue;
							seenHitIds.add(dedupeKey);
							mergedHits.push(hit);
							if (mergedHits.length >= limit * Math.max(1, searchQueries.length)) break;
						}
						if (mergedHits.length >= limit * Math.max(1, searchQueries.length)) break;
					}
					allHits = mergedHits.slice(0, Math.max(limit, limit * Math.min(searchQueries.length, 4)));

					// Fall back to external search if local indexes yield very few results (often true when sidecars are small subsets)
					// similar to the threshold in api/finra/search/route.ts but higher since we merge 4 buckets here.
					if (allHits.length < Math.min(limit, 50)) {
						const externalResults = [];
						for (const sq of searchQueries) {
							const results = await Promise.all([
								searchExternalFallback('finra', 'individual', sq, baseUrl),
								searchExternalFallback('finra', 'firm', sq, baseUrl),
								searchExternalFallback('sec', 'individual', sq, baseUrl),
								searchExternalFallback('sec', 'firm', sq, baseUrl),
							]);
							externalResults.push(...results);
							if (searchQueries.length > 1) {
								await new Promise((resolve) => setTimeout(resolve, 500));
							}
						}
						const extHits = externalResults.flatMap((result) => result?.hits?.hits || []).slice(0, limit);
						if (extHits.length) {
							allHits = extHits;
						}
					}
				}

				if (!allHits.length) {
					// Numeric CRD fallback: hydrate directly from detail routes even when local index is stale.
					if (/^\d{1,10}$/.test(q)) {
						const directNodes: any[] = [];
						const directLinks: any[] = [];
						const directMatchedIds = new Set<string>();

						if (type === 'all' || type === 'individual') {
							try {
								const response = await fetch(`${baseUrl}/api/finra/individual/${encodeURIComponent(q)}?merged=1&includePrevious=true`, {
									headers: { Accept: 'application/json' },
									cache: 'no-store',
								});
								const detail = await response.json().catch(() => null);
								if (response.ok && detail?.found !== false) {
									const built = buildNodesFromIndividualDetail(detail, q);
									directNodes.push(...built.nodes);
									directLinks.push(...built.links);
									for (const id of built.matchedIds) directMatchedIds.add(id);
								}
							} catch {
								// ignore per-route fetch failure
							}
						}

						if (type === 'all' || type === 'firm') {
							try {
								const response = await fetch(`${baseUrl}/api/finra/firm/${encodeURIComponent(q)}?merged=1`, {
									headers: { Accept: 'application/json' },
									cache: 'no-store',
								});
								const detail = await response.json().catch(() => null);
								if (response.ok && detail?.found !== false) {
									const built = buildNodesFromFirmDetail(detail, q);
									directNodes.push(...built.nodes);
									directLinks.push(...built.links);
									for (const id of built.matchedIds) directMatchedIds.add(id);
								}
							} catch {
								// ignore per-route fetch failure
							}
						}

						if (directNodes.length) {
							await persistGraphSearchNodesAndLinks(directNodes, directLinks);
							return NextResponse.json({ nodes: directNodes, links: directLinks, matchedIds: Array.from(directMatchedIds) });
						}

						// Final numeric fallback: derive nodes from dashboard cache-card index (Redis-backed).
						const cards = await fetchCacheCardsFallback(baseUrl, q);
						if (cards.length) {
							const built = buildNodesFromCacheCards(cards, type);
							if (built.nodes.length) {
								await persistGraphSearchNodesAndLinks(built.nodes, built.links);
								return NextResponse.json({ nodes: built.nodes, links: built.links, matchedIds: built.matchedIds });
							}
						}
					}

					return NextResponse.json({ nodes: [], links: [], matchedIds: [] });
				}

				// Build nodes/links from hits (similar to client-side logic)
				const newNodes: any[] = [];
				const newLinks: any[] = [];
				const seenIds = new Set<string>();

				for (const hit of allHits) {
					const src = (hit && typeof hit === 'object' && '_source' in hit ? (hit as { _source?: Record<string, any> })._source : hit) as Record<string, any>;
					const resolved = resolveIndividualSourceDetail(src);
					const parsed = (resolved.detail || normalizeIndividualDetailFromSource(src)) as Record<string, any>;

					// FINRA local search-index docs are minimal stubs (`{id, crd, label, type, source}`)
					// rather than full SEC-style records, so fall back to the stub's own `crd`/`type`
					// fields when the richer SEC field names aren't present.
					const isStubIndividual = String(src?.type || '').toLowerCase() === 'individual';
					const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || (isStubIndividual ? src?.crd : '') || '').trim();
					if (crd) {
						const personId = `person:${crd}`;
						if (!seenIds.has(personId)) {
							seenIds.add(personId);
							const label =
								[
									parsed?.basicInformation?.firstName || src?.ind_firstname,
									parsed?.basicInformation?.middleName || src?.ind_middlename,
									parsed?.basicInformation?.lastName || src?.ind_lastname,
								]
									.filter(Boolean)
									.join(' ') || src?.label || `CRD ${crd}`;
							const personNode: Record<string, any> = {
								id: personId,
								label,
								group: 'individual',
								crd,
								_source: 'local-search',
								basicInformation: parsed?.basicInformation || null,
								bcScope: parsed?.bcScope ?? parsed?.basicInformation?.bcScope ?? null,
								iaScope: parsed?.iaScope ?? parsed?.basicInformation?.iaScope ?? null,
								currentEmployments: resolved.hasEmbeddedDetail && Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : [],
								previousEmployments: resolved.hasEmbeddedDetail && Array.isArray(parsed?.previousEmployments) ? parsed.previousEmployments : [],
								currentIAEmployments: resolved.hasEmbeddedDetail && Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : [],
								previousIAEmployments: resolved.hasEmbeddedDetail && Array.isArray(parsed?.previousIAEmployments) ? parsed.previousIAEmployments : [],
								registrationCount: parsed?.registrationCount || null,
								disclosures: parsed?.disclosures || null,
								iaDisclosures: parsed?.iaDisclosures || null,
								hasFinraData: resolved.hasFinraData,
								hasSecData: resolved.hasSecData,
								_trustedCurrentRelationshipData: Boolean(
									resolved.hasEmbeddedDetail &&
									((parsed?.currentEmployments && parsed.currentEmployments.length) ||
										(parsed?.previousEmployments && parsed.previousEmployments.length) ||
										(parsed?.currentIAEmployments && parsed.currentIAEmployments.length) ||
										(parsed?.previousIAEmployments && parsed.previousIAEmployments.length) ||
										parsed?.registrationCount),
								),
							};
							newNodes.push(personNode);

							const emps =
								resolved.hasEmbeddedDetail ?
									[
										...(Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : []),
										...(Array.isArray(parsed?.previousEmployments) ? parsed.previousEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
										...(Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : []),
										...(Array.isArray(parsed?.previousIAEmployments) ? parsed.previousIAEmployments.map((employment: any) => ({ ...employment, _isCurrent: false })) : []),
									]
								:	[];
							for (const e of emps) {
								const fid = String(e?.firm_id || e?.firmId || '').trim();
								if (!fid) continue;
								const firmNodeId = `firm:${fid}`;
								if (!seenIds.has(firmNodeId)) {
									seenIds.add(firmNodeId);
									newNodes.push({
										id: firmNodeId,
										label: e?.firm_name || e?.firmName || `Firm ${fid}`,
										group: 'firm',
										firmId: fid,
										_source: 'local-search',
										firmStatus: e?.firmStatus || e?.status || e?.registrationStatus || null,
										bcScope: e?.firmBCScope || e?.bcScope || null,
									});
								}
								newLinks.push({
									source: personId,
									target: firmNodeId,
									relationship: e?._isCurrent === false ? 'previous_employed_by' : 'employed_by',
									isCurrent: e?._isCurrent !== false,
								});
							}
						}
						continue;
					}

					// FINRA local search-index docs are minimal stubs (`{id, crd, label, type, source}`)
					// rather than full SEC-style records, so fall back to the stub's own `crd` field
					// when the richer SEC field names (`firm_id`, `firmId`, `firm_source_id`) aren't present.
					const isStubFirm = String(src?.type || '').toLowerCase() === 'firm';
					const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || (isStubFirm ? src?.crd : '') || '').trim();
					if (firmId) {
						const firmNodeId = `firm:${firmId}`;
						if (!seenIds.has(firmNodeId)) {
							seenIds.add(firmNodeId);
							newNodes.push({
								id: firmNodeId,
								label: src?.firm_name || src?.firmName || src?.label || `Firm ${firmId}`,
								group: 'firm',
								firmId,
								_source: 'local-search',
								firmStatus: src?.firmStatus || src?.status || src?.registrationStatus || src?.basicInformation?.firmStatus || null,
								bcScope: src?.firm_bc_scope || src?.bcScope || src?.basicInformation?.bcScope || null,
								iaScope: src?.iaScope || src?.basicInformation?.iaScope || null,
							});
						}
					}
				}

				await persistGraphSearchNodesAndLinks(newNodes, newLinks);

				return NextResponse.json({ nodes: newNodes, links: newLinks, matchedIds: Array.from(seenIds) });
			} catch (e: any) {
				logger.error('graph-search local index fallback failed', { error: e?.message || String(e) });
				return NextResponse.json({ nodes: [], links: [], matchedIds: [] });
			}
		}

		const links = (graph.links || []).filter((link: any) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			return matchedIds.has(sourceId) || matchedIds.has(targetId);
		});

		const includedNodeIds = new Set<string>(matchedIds);
		links.forEach((link: any) => {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId) includedNodeIds.add(sourceId);
			if (targetId) includedNodeIds.add(targetId);
		});

		return NextResponse.json({
			nodes: nodes.filter((node) => includedNodeIds.has(String(node?.id || '').trim())),
			links,
			matchedIds: Array.from(matchedIds),
		});
	} catch (err: any) {
		logger.error('graph-search error', { error: err.message });
		return NextResponse.json({ error: 'Failed to search graph.' }, { status: 500 });
	}
}
