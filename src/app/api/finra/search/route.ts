import { NextRequest, NextResponse } from 'next/server';
import { hasMinimumSearchQuery, searchLocalIndexMany, extractSearchQueries, mergeLocalSearchResponses, searchQueriesSequentially } from '@/lib/localSearch';
import { logger } from '@/lib/logger';
import { searchGraphFallback } from '@/lib/searchGraphFallback';
import { searchDirectRedisFallback } from '@/lib/searchDirectFallback';
import { searchExternalFallback } from '@/lib/searchExternalFallback';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonNoStore(data: unknown, init: Parameters<typeof NextResponse.json>[1] = {}) {
	return NextResponse.json(data, {
		...init,
		headers: {
			'Cache-Control': 'no-store, max-age=0, must-revalidate',
			...(init?.headers || {}),
		},
	});
}

function buildFinraSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	const rawRows = searchParams.get('rows');
	const rawPageSize = searchParams.get('pageSize');
	const rawPageNumber = searchParams.get('pageNumber');

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'type' || key === 'firm') continue;
		if (key === 'q') {
			if (!searchParams.has('query')) params.set('query', value);
			continue;
		}
		if (key === 'rows') {
			if (!searchParams.has('nrows')) params.set('nrows', value);
			continue;
		}
		if (key === 'pageSize') {
			if (!searchParams.has('nrows')) params.set('nrows', value);
			continue;
		}
		if (key === 'pageNumber') continue;
		params.set(key, value);
	}

	if (!params.has('query')) return null;
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('nrows') && rawRows) params.set('nrows', rawRows);
	if (!params.has('nrows') && rawPageSize) params.set('nrows', rawPageSize);
	if (!params.has('nrows')) params.set('nrows', '12');
	if (!params.has('start') && rawPageNumber) {
		const pageNumber = Number.parseInt(rawPageNumber, 10);
		const nrows = Number.parseInt(params.get('nrows') || '12', 10);
		if (Number.isFinite(pageNumber) && pageNumber > 0 && Number.isFinite(nrows) && nrows > 0) {
			params.set('start', String((pageNumber - 1) * nrows));
		}
	}
	if (!params.has('start')) params.set('start', '0');

	return params;
}

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = new URL(request.url);
		const baseUrl = new URL(request.url).origin;
		const type = searchParams.get('type') || (searchParams.get('firm') ? 'firm' : 'individual');
		const params = buildFinraSearchParams(searchParams);
		if (!params) return jsonNoStore({ hits: { hits: [] } });

		const rawQuery = params.get('query') || '';
		const searchQueries = extractSearchQueries(rawQuery).filter(Boolean);
		const query = searchQueries[0] || rawQuery.trim();
		if (!searchQueries.some((candidate) => hasMinimumSearchQuery(candidate)))
			return jsonNoStore({ hits: { hits: [] }, response: { docs: [], numFound: 0, start: 0 }, results: [], total: 0, currentPage: [], pageNumber: 1, pageSize: 0 });
		const limit = Math.min(Number.parseInt(params.get('nrows') || '12', 10) || 12, 200);
		const offset = Number.parseInt(params.get('start') || '0', 10) || 0;
		const entity = type === 'firm' ? 'firm' : 'individual';
		const emptyResponse = {
			hits: { hits: [] },
			response: { docs: [], numFound: 0, start: 0 },
			results: [],
			total: 0,
			currentPage: [],
			pageNumber: 1,
			pageSize: 0,
		};

		let data: any = emptyResponse;
		let skipLocalIndexSearch = false;

		if (/^\d{1,10}$/.test(query)) {
			const { isCrdInInventory } = await import('@/lib/crdInventorySidecar');
			const inv = isCrdInInventory(query);
			if (inv.isFirm || inv.isIndividual) {
				skipLocalIndexSearch = true;
			}
		}

		if (!skipLocalIndexSearch) {
			try {
				if (rawQuery.includes(',')) {
					// User explicitly provided multiple distinct queries; run them all and merge results
					const responses = await Promise.all(
						searchQueries.map((q) => searchLocalIndexMany('finra', entity, q, { limit, offset, baseUrl }))
					);
					data = mergeLocalSearchResponses(responses as any[], { bucket: `finra:${entity}`, limit, offset });
				} else {
					// Keep any local hits. Requiring total >= 50 discarded valid results whenever
					// nrows capped the reported total below 50, then forced slow graph fallbacks.
					const localResponses = await searchQueriesSequentially(
						searchQueries,
						(candidate) => searchLocalIndexMany('finra', entity, candidate, { limit, offset, baseUrl }),
						(response) => Boolean(response && (response.hits?.total || response.total || 0) > 0),
					);
					data = localResponses.length > 0 ? mergeLocalSearchResponses(localResponses as any[], { bucket: `finra:${entity}`, limit, offset }) : emptyResponse;
				}
			} catch (err: any) {
				logger.warn('local search index lookup failed for FINRA query', { query: rawQuery, error: err?.message || String(err) });
				data = emptyResponse;
			}
		}
		const total = data?.total || 0;
		// Prefer the local search index. Fallbacks only run when local found nothing
		// (e.g. CRD inventory short-circuit, missing sidecar entry).
		if (total > 0) return jsonNoStore(data);

		const fallbackQueries = rawQuery.includes(',') ? searchQueries : searchQueries.slice(0, 5);
		const allResponses: any[] = [];

		const graphResponses = rawQuery.includes(',') ?
			await Promise.all(
				fallbackQueries.map(async (candidate) => {
					try {
						return await searchGraphFallback('finra', entity, candidate, { limit, offset });
					} catch (err: any) {
						logger.warn('graph fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
						return null;
					}
				})
			).then(res => res.filter(Boolean))
			: await searchQueriesSequentially(
			fallbackQueries,
			async (candidate) => {
				try {
					return await searchGraphFallback('finra', entity, candidate, { limit, offset });
				} catch (err: any) {
					logger.warn('graph fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
					return null;
				}
			},
			(value) => Boolean(value && value.total > 0),
		);
		if (graphResponses.length > 0) {
			allResponses.push(...graphResponses);
		}

		const directResponses = rawQuery.includes(',') ?
			await Promise.all(
				fallbackQueries.map(async (candidate) => {
					try {
						return await searchDirectRedisFallback('finra', entity, candidate, { limit, offset });
					} catch (err: any) {
						logger.warn('direct Redis fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
						return null;
					}
				})
			).then(res => res.filter(Boolean))
			: await searchQueriesSequentially(
			fallbackQueries,
			async (candidate) => {
				try {
					return await searchDirectRedisFallback('finra', entity, candidate, { limit, offset });
				} catch (err: any) {
					logger.warn('direct Redis fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
					return null;
				}
			},
			(value) => Boolean(value),
		);
		if (directResponses.length > 0) {
			allResponses.push(...directResponses);
		}

		// Throttle external responses when using multiple comma separated values to avoid 429
		if (rawQuery.includes(',')) {
			for (const candidate of fallbackQueries) {
				try {
					const res = await searchExternalFallback('finra', entity, candidate, baseUrl);
					if (res) allResponses.push(res);
					await new Promise((resolve) => setTimeout(resolve, 500));
				} catch (err: any) {
					logger.warn('external fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
				}
			}
		} else {
			const seqResp = await searchQueriesSequentially(
				fallbackQueries,
				async (candidate) => {
					try {
						return await searchExternalFallback('finra', entity, candidate, baseUrl);
					} catch (err: any) {
						logger.warn('external fallback search failed for FINRA query', { candidate, error: err?.message || String(err) });
						return null;
					}
				},
				(value) => Boolean(value),
			);
			allResponses.push(...seqResp.filter(Boolean));
		}

		if (allResponses.length > 0) {
			const merged = mergeLocalSearchResponses(allResponses, { bucket: `finra:${entity}`, limit, offset });
			return jsonNoStore(merged);
		}

		return jsonNoStore(emptyResponse);
	} catch (err: any) {
		logger.error('search error', { error: err?.message || String(err), query: request.nextUrl?.searchParams?.get('query') || '' });
		return jsonNoStore({ hits: { hits: [] }, response: { docs: [], numFound: 0, start: 0 }, results: [], total: 0, currentPage: [], pageNumber: 1, pageSize: 0 });
	}
}
