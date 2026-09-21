import type { LocalSearchResponse } from './localSearch';
import { canCallExternalApis } from './externalApiGate';

function getNumericId(item: any, isIndividual: boolean): string {
	const keys =
		isIndividual ?
			['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id']
		:	['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];
	for (const key of keys) {
		const raw = item?.[key];
		if (raw == null) continue;
		const value = String(raw).trim();
		if (/^\d{1,10}$/.test(value)) return value;
	}
	return '';
}

export async function searchExternalFallback(source: 'finra' | 'sec', entity: 'individual' | 'firm', query: string, baseUrl: string): Promise<LocalSearchResponse | null> {
	if (!canCallExternalApis()) {
		return null;
	}

	const encoded = encodeURIComponent(query);
	const queryParams = entity === 'individual' ? 'hl=true&includePrevious=true&nrows=100&start=0&wt=json' : 'hl=true&nrows=100&start=0&wt=json';
	const url =
		source === 'finra' ?
			`https://api.brokercheck.finra.org/search/${entity}?query=${encoded}&${queryParams}`
		:	`https://api.adviserinfo.sec.gov/search/${entity}?query=${encoded}&${queryParams}`;

	const fetchOptions = {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'Referer': source === 'finra' ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
		},
		next: { revalidate: 3600 },
	};

	try {
		const domain = source === 'finra' ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov';
		console.log(`[External API Access] Time: ${new Date().toISOString()} | Accessing external API: ${url} | Domain: ${domain} | CRDs: [] | Count: 0`);
		const res = await fetch(url, fetchOptions);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const externalData = await res.json();
		const hits = externalData?.hits?.hits || [];

		// If external API returns structure containing results or docs directly
		const results = hits.map((hit: any) => hit?._source || hit);

		if (!hits.length) return null;

		// The background caching loop has been removed as per user request
		// to prevent automatic fetching of external API details on search fallback.


		const prefix = entity === 'individual' ? 'person:' : 'firm:';

		return {
			bucket: `${source}:${entity}`,
			generatedAt: new Date().toISOString(),
			total: externalData?.hits?.total || hits.length,
			hits: {
				total: externalData?.hits?.total || hits.length,
				start: 0,
				hits: hits.map((hit: any) => {
					const rawId = String(hit?._source?.ind_source_id || hit?._source?.firm_source_id || hit?.ind_source_id || hit?.firm_source_id || hit?._id || '');
					const nodeId = rawId ? `${prefix}${rawId}` : '';
					return {
						_id: nodeId,
						_source: hit?._source || hit,
					};
				}),
			},
			response: {
				numFound: externalData?.hits?.total || hits.length,
				start: 0,
				docs: results,
			},
			results,
			currentPage: results,
			pageNumber: 1,
			pageSize: 100,
		};
	} catch (err: any) {
		console.warn(`[searchExternalFallback] External search fetch failed for ${source}:${entity}:${query}`, err.message);
		return null;
	}
}
