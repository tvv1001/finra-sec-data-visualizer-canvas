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

function buildSecSearchParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	const rawRows = searchParams.get('rows');
	const rawPageSize = searchParams.get('pageSize');
	const rawPageNumber = searchParams.get('pageNumber');

	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
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
		const params = buildSecSearchParams(searchParams);
		if (!params) return jsonNoStore({ hits: { hits: [] } });

		const rawQuery = params.get('query') || '';
		const searchQueries = extractSearchQueries(rawQuery).filter(Boolean);
		const query = searchQueries[0] || rawQuery.trim();
		if (!searchQueries.some((candidate) => hasMinimumSearchQuery(candidate)))
			return jsonNoStore({ hits: { hits: [] }, response: { docs: [], numFound: 0, start: 0 }, results: [], total: 0, currentPage: [], pageNumber: 1, pageSize: 0 });
		const limit = Math.min(Number.parseInt(params.get('nrows') || '12', 10) || 12, 200);
		const offset = Number.parseInt(params.get('start') || '0', 10) || 0;
		let data = { total: 0 };
		let skipLocalIndexSearch = false;
		if (/^\d{1,10}$/.test(query)) {
			const { isCrdInInventory } = await import('@/lib/crdInventorySidecar');
			const inv = isCrdInInventory(query);
			if (inv.isFirm || inv.isIndividual) {
				skipLocalIndexSearch = true;
			}
		}

		if (!skipLocalIndexSearch) {
			data = await searchLocalIndexMany('sec', 'firm', rawQuery, { limit, offset, baseUrl });
		}
		// Prefer local index hits; nrows-capped totals below 50 are still valid results.
		if (data.total > 0) return jsonNoStore(data);

		const fallbackQueries = searchQueries.slice(0, 5);
		const allResponses: any[] = [];

		const graphResponses = await searchQueriesSequentially(
			fallbackQueries,
			async (candidate) => searchGraphFallback('sec', 'firm', candidate, { limit, offset }),
			(value) => Boolean(value && value.total > 0),
		);
		if (graphResponses.length > 0) allResponses.push(...graphResponses);

		const directResponses = await searchQueriesSequentially(
			fallbackQueries,
			async (candidate) => searchDirectRedisFallback('sec', 'firm', candidate, { limit, offset }),
			(value) => Boolean(value),
		);
		if (directResponses.length > 0) allResponses.push(...directResponses);

		const externalResponses = await searchQueriesSequentially(
			fallbackQueries,
			async (candidate) => searchExternalFallback('sec', 'firm', candidate, baseUrl),
			(value) => Boolean(value),
		);
		if (externalResponses.length > 0) allResponses.push(...externalResponses);

		if (allResponses.length > 0) {
			const merged = mergeLocalSearchResponses(allResponses, { bucket: 'sec:firm', limit, offset });
			return jsonNoStore(merged);
		}

		return jsonNoStore({ hits: { hits: [] }, response: { docs: [], numFound: 0, start: 0 }, results: [], total: 0, currentPage: [], pageNumber: 1, pageSize: 0 });
	} catch (err: any) {
		logger.error('sec-search-firm error', { error: err.message });
		return jsonNoStore({ error: 'Failed to search SEC firms.' }, { status: 502 });
	}
}
