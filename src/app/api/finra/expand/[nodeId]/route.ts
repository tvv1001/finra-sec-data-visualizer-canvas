import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient } from '@/lib/redisCache';
import { isValidCrd, ensureFirmCrd, ensurePersonCrd, makeRedisKey } from '@/lib/crd';
import { getNeighborsForNodes, toCompactNode } from '@/lib/graphStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { tryLoadPersonCluster } from '@/lib/peopleClusterCache';
import { hydrateGraphNodesFromSearchSidecar, searchLocalIndex } from '@/lib/localSearch';
import { getFirmConnectionsFromGraph } from '@/lib/graphConnections';
import { lookupFirmEmploymentEdgesFromPrimed } from '@/lib/firmEmploymentFromPrimed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Firm reverse-index cold path can exceed the default serverless budget before adj keys exist.
export const maxDuration = 60;

function normalizeHopsParam(value: string | null): number | 'all' {
	if (typeof value === 'string' && value.trim().toLowerCase() === 'all') {
		return 'all';
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return 1;
	}

	return Math.floor(parsed);
}

function isStrictExpansionRequest(value: string | null): boolean {
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function decodeNodeId(value: string | null | undefined): string {
	const raw = String(value || '').trim();
	if (!raw) return '';
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ nodeId: string }> }) {
	try {
		const { nodeId: rawNodeId } = await params;
		const nodeId = decodeNodeId(rawNodeId);
		const hops = normalizeHopsParam(request.nextUrl.searchParams.get('hops'));
		const strictExpansion = isStrictExpansionRequest(request.nextUrl.searchParams.get('strict'));
		const baseUrl = new URL(request.url).origin;

		// Support multiple node IDs via query param 'ids' (comma-separated)
		const extraIds =
			request.nextUrl.searchParams
				.get('ids')
				?.split(',')
				.map((id) => decodeNodeId(id))
				.filter(Boolean) || [];
		const allIds = Array.from(new Set([nodeId, ...extraIds]));

		// Fast path for single person expansion (cluster lookup)
		if (!strictExpansion && allIds.length === 1 && hops === 1 && nodeId.startsWith('person:')) {
			try {
				const crd = nodeId.slice('person:'.length);
				if (isValidCrd(crd)) {
					const cluster = await tryLoadPersonCluster(crd);
					if (cluster) {
						await hydrateGraphNodesFromSearchSidecar(cluster.nodes || [], { baseUrl });
						return NextResponse.json(
							{
								nodes: Array.isArray(cluster.nodes) ? cluster.nodes.map(toCompactNode) : [],
								links: cluster.links || [],
							},
							{ headers: sharedCacheHeaders(300) },
						);
					}
				} else {
					// invalid person CRD, skip cluster fast path
				}
			} catch (error) {
				console.warn(`Expansion API: people-cluster lookup failed for ${nodeId}`, error);
			}
		}

		// Fast path for single node (Redis cache check).
		// Skip firm expand cache: empty mono-graph neighborhoods were cached before reverse-index hydration existed.
		if (!strictExpansion && allIds.length === 1 && hops === 1 && !nodeId.startsWith('firm:')) {
			try {
				const redis = getRedisClient();
				if (redis) {
					const cached = await redis.get<any>(`finra:expand:${nodeId}:1`);
					if (cached) {
						await hydrateGraphNodesFromSearchSidecar(cached.nodes || [], { baseUrl });
						return NextResponse.json(cached, { headers: sharedCacheHeaders(300) });
					}
				}
			} catch (e) {
				console.warn(`Expansion API: Cache check failed for ${nodeId}`, e);
			}
		}

		const result = await getNeighborsForNodes(allIds, hops);

		// If expanding a firm, hydrate employees from primed reverse index / connections
		// (mono session graph often has the firm node with zero employed_by edges).
		if (nodeId.startsWith('firm:') && hops === 1) {
			try {
				const rawFirm = nodeId.replace(/^firm:/, '');
				let firmId = rawFirm;
				if (!isValidCrd(rawFirm)) {
					console.warn(`Expansion API: invalid firm CRD '${rawFirm}' requested`);
				} else {
					firmId = ensureFirmCrd(rawFirm);
				}
				const seenNodeIds = new Set(result.nodes.map((n) => n.id));
				let firmNode = result.nodes.find((n) => n.id === nodeId);

				if (!seenNodeIds.has(nodeId)) {
					let firmLabel = `Firm ${firmId}`;
					try {
						const redis = getRedisClient();
						if (redis) {
							const cachedFirm = isValidCrd(firmId) ? await redis.get<any>(makeRedisKey('finra', 'firm', firmId)) : null;
							if (cachedFirm) {
								const cachedHits = cachedFirm?.hits?.hits || [];
								const rawDetail = cachedHits.length > 0 ? cachedHits[0]?._source?.content || cachedHits[0]?._source : cachedFirm;
								let parsed: any = rawDetail;
								// Defensive: only attempt JSON.parse on strings that look like JSON to avoid
								// parsing plain legacy identifiers like "br:XYZ" which will throw.
								if (typeof rawDetail === 'string') {
									const t = rawDetail.trim();
									if (t.startsWith('{') || t.startsWith('[')) {
										try {
											parsed = JSON.parse(rawDetail);
										} catch {
											parsed = rawDetail;
										}
									}
								}
								const bi = parsed?.basicInformation || parsed || {};
								firmLabel = bi.firmName || bi.name || firmLabel;
							}
						}
					} catch (e) {
						console.warn(`Expansion API: Failed to load firm details for node label`, e);
					}
					firmNode = {
						id: nodeId,
						label: firmLabel,
						group: 'firm',
						firmId,
					};
					result.nodes.push(firmNode);
					seenNodeIds.add(nodeId);
				}

				// Prefer O(1) precomputed adj when warm (including an authoritative empty roster).
				// A primed-bundle hit is incomplete — only people in that snapshot — so merge via
				// getFirmConnectionsFromGraph instead of treating one bundle match as the full list.
				let connectionEntries: Array<{ individualId?: string; firmId?: string; name: string; isCurrent: boolean; startDate?: string; endDate?: string }> = [];
				let usedPrecomputedAdj = false;
				try {
					const primedLookup = await lookupFirmEmploymentEdgesFromPrimed(firmId);
					if (primedLookup.source === 'adj') {
						usedPrecomputedAdj = true;
						connectionEntries = primedLookup.edges.map((edge) => ({
							individualId: edge.personCrd,
							name: edge.personName,
							isCurrent: edge.isCurrent,
							startDate: edge.startDate,
							endDate: edge.endDate,
						}));
					}
				} catch {
					connectionEntries = [];
				}

				if (!usedPrecomputedAdj) {
					const { currentConnections = [], previousConnections = [] } = await getFirmConnectionsFromGraph(firmId);
					connectionEntries = [
						...currentConnections.map((entry) => ({
							individualId: entry.individualId,
							firmId: entry.firmId,
							name: entry.name,
							isCurrent: true as boolean,
							startDate: entry.startDate,
							endDate: entry.endDate,
						})),
						...previousConnections.map((entry) => ({
							individualId: entry.individualId,
							firmId: entry.firmId,
							name: entry.name,
							isCurrent: false as boolean,
							startDate: entry.startDate,
							endDate: entry.endDate,
						})),
					];
				}

				for (const entry of connectionEntries) {
					const personCrd = String(entry?.individualId || '').trim();
					const relatedFirmId = String(entry?.firmId || '').trim();
					const isFirm = Boolean(relatedFirmId && !personCrd);
					const crd = isFirm ? relatedFirmId : personCrd;
					if (!crd) continue;
					const otherId = isFirm ? `firm:${crd}` : `person:${crd}`;
					if (!seenNodeIds.has(otherId)) {
						result.nodes.push({
							id: otherId,
							label: entry?.name || `${isFirm ? 'Firm' : 'CRD'} ${crd}`,
							group: isFirm ? 'firm' : 'individual',
							crd,
							firmId: isFirm ? crd : undefined,
							_source: 'expansion-firm-connections',
						});
						seenNodeIds.add(otherId);
					}

					const relationship = isFirm ? (entry.isCurrent === false ? 'previously_associated' : 'associated') : entry.isCurrent === false ? 'previous_employed_by' : 'employed_by';
					const linkExists = result.links.some((l) => {
						const sourceId = String(l.source?.id ?? l.source ?? '');
						const targetId = String(l.target?.id ?? l.target ?? '');
						return (sourceId === otherId && targetId === nodeId) || (sourceId === nodeId && targetId === otherId);
					});

					if (!linkExists) {
						result.links.push({
							source: otherId,
							target: nodeId,
							relationship,
							isCurrent: entry.isCurrent !== false,
							startDate: entry.startDate || null,
							endDate: entry.endDate || null,
						});
					}
				}

				// Secondary: bounded local search only when reverse index returned nothing.
				if (connectionEntries.length === 0 && !usedPrecomputedAdj) {
					const searchById = await Promise.race([
						searchLocalIndex('finra', 'individual', firmId, { limit: 100, baseUrl }),
						new Promise<any>((resolve) => setTimeout(() => resolve({ results: [] }), 2500)),
					]);
					const hits = searchById?.results || [];
					if (hits.length === 0 && firmNode && firmNode.label) {
						const searchByName = await Promise.race([
							searchLocalIndex('finra', 'individual', firmNode.label, { limit: 100, baseUrl }),
							new Promise<any>((resolve) => setTimeout(() => resolve({ results: [] }), 2500)),
						]);
						hits.push(...(searchByName?.results || []));
					}
					for (const hit of hits) {
						const crd = String(hit.ind_source_id || hit.ind_crd || '').trim();
						if (!crd) continue;
						const personId = `person:${crd}`;
						if (!seenNodeIds.has(personId)) {
							const label = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ') || `CRD ${crd}`;
							result.nodes.push({
								id: personId,
								label,
								group: 'individual',
								crd,
								_source: 'expansion-search',
							});
							seenNodeIds.add(personId);
						}
						const linkExists = result.links.some((l) => (l.source?.id ?? l.source) === personId && (l.target?.id ?? l.target) === nodeId);
						if (!linkExists) {
							result.links.push({
								source: personId,
								target: nodeId,
								relationship: 'employed_by',
								isCurrent: true,
							});
						}
					}
				}
			} catch (e) {
				console.warn(`Expansion API: firm employee search failed for ${nodeId}`, e);
			}
		}

		await hydrateGraphNodesFromSearchSidecar(result.nodes || [], { baseUrl });
		return NextResponse.json(
			{
				nodes: Array.isArray(result.nodes) ? result.nodes.map(toCompactNode) : [],
				links: result.links || [],
			},
			{ headers: sharedCacheHeaders(300) },
		);
	} catch (err: any) {
		logger.error('expand error', { error: err.message });
		return NextResponse.json({ error: 'Failed to expand node.' }, { status: 500 });
	}
}
