// Official FINRA / SEC individual-by-firm search.
// These endpoints return everyone whose current or previous employment matches
// the firm CRD or a firm-name token (e.g. firm=72 → 724 CAPITAL, 72CAPITAL).
// Results are written into data/firm-connections/{firmId}.json (the collection
// the dashboard and graph sidebar already read).
import type { GraphConnectionEntry } from '@/lib/graphConnections';
// Type-only import — keep this file free of a runtime cycle with graphConnections.

export const OFFICIAL_FIRM_ROSTER_SOURCE = 'official-search';
export const OFFICIAL_SEARCH_PAGE_SIZE = 100;
const OFFICIAL_SEARCH_PAGE_CONCURRENCY = 6;

const SEARCH_HEADERS = {
	Accept: 'application/json',
	'User-Agent': 'Mozilla/5.0 (compatible; finra-graph/1.0)',
} as const;

export type OfficialFirmRoster = {
	currentConnections: GraphConnectionEntry[];
	previousConnections: GraphConnectionEntry[];
	source: typeof OFFICIAL_FIRM_ROSTER_SOURCE;
	officialTotals: { finra: number; sec: number };
	fetchedAt: string;
};

function toArraySafe(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values: unknown[]) {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text) return text;
	}
	return '';
}

function numericTotal(total: unknown): number {
	if (typeof total === 'number' && Number.isFinite(total)) return total;
	if (total && typeof total === 'object' && typeof (total as { value?: unknown }).value === 'number') {
		return Number((total as { value: number }).value);
	}
	return 0;
}

function officialSearchUrl(source: 'finra' | 'sec', firmId: string, start: number): string {
	const params = new URLSearchParams({
		firm: firmId,
		includePrevious: 'true',
		hl: 'true',
		wt: 'json',
		nrows: String(OFFICIAL_SEARCH_PAGE_SIZE),
		start: String(start),
	});
	const host = source === 'finra' ? 'https://api.brokercheck.finra.org' : 'https://api.adviserinfo.sec.gov';
	return `${host}/search/individual?${params.toString()}`;
}

function innerHitSources(hit: any, keys: string[]): any[] {
	const inner = hit?.inner_hits || {};
	const out: any[] = [];
	for (const key of keys) {
		const rows = inner?.[key]?.hits?.hits;
		for (const row of toArraySafe(rows)) {
			if (row?._source) out.push(row._source);
		}
	}
	return out;
}

function employmentFirmId(entry: any): string {
	return firstNonEmpty(entry?.firmId, entry?.firm_id);
}

function employmentFirmName(entry: any): string {
	return firstNonEmpty(entry?.firmName, entry?.firm_name);
}

function mergeOfficialEntries(lists: GraphConnectionEntry[][]): { currentConnections: GraphConnectionEntry[]; previousConnections: GraphConnectionEntry[] } {
	const current: GraphConnectionEntry[] = [];
	const previous: GraphConnectionEntry[] = [];
	const seen = new Set<string>();
	for (const entry of lists.flat()) {
		const id = firstNonEmpty(entry?.individualId, entry?.firmId);
		if (!id) continue;
		const kind = entry?.firmId && !entry?.individualId ? 'firm' : 'person';
		const key = `${kind}:${id}:${entry.isCurrent ? '1' : '0'}`;
		if (seen.has(key)) continue;
		seen.add(key);
		(entry.isCurrent ? current : previous).push(entry);
	}
	return { currentConnections: current, previousConnections: previous };
}

export function mapOfficialSearchHitsToConnections(firmId: string, hits: any[], evidenceTag: string): GraphConnectionEntry[] {
	const query = String(firmId || '').trim();
	const entries: GraphConnectionEntry[] = [];
	const seenPerson = new Set<string>();
	const seenFirm = new Set<string>();

	for (const hit of hits) {
		const src = hit?._source || hit || {};
		const personCrd = firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, src.id);
		const personName = firstNonEmpty([src.ind_firstname, src.ind_middlename, src.ind_lastname].filter(Boolean).join(' '), src.individualName, src.name);

		const currentMatched = [
			...innerHitSources(hit, ['ind_current_employments', 'ind_ia_current_employments']),
			...toArraySafe(src.ind_current_employments),
			...toArraySafe(src.currentEmployments),
			...toArraySafe(src.currentIAEmployments),
		];
		const previousMatched = [
			...innerHitSources(hit, ['ind_previous_employments', 'ind_ia_previous_employments']),
			...toArraySafe(src.ind_previous_employments),
			...toArraySafe(src.ind_ia_previous_employments),
			...toArraySafe(src.previousEmployments),
			...toArraySafe(src.previousIAEmployments),
		];

		const currentAtQuery = currentMatched.filter((entry) => employmentFirmId(entry) === query);
		const previousAtQuery = previousMatched.filter((entry) => employmentFirmId(entry) === query);
		const hasExactCurrent = currentAtQuery.length > 0;
		const hasExactPrevious = previousAtQuery.length > 0;

		const personIsCurrent = hasExactCurrent;
		const personIsPrevious = !personIsCurrent && hasExactPrevious;
		if (personCrd && (personIsCurrent || personIsPrevious) && !seenPerson.has(`${personCrd}:${personIsCurrent ? '1' : '0'}`)) {
			seenPerson.add(`${personCrd}:${personIsCurrent ? '1' : '0'}`);
			const matchedEmp = personIsCurrent ? currentAtQuery[0] : previousAtQuery[0];
			const branch = toArraySafe(matchedEmp?.branchOfficeLocations)[0] || matchedEmp;
			const city = firstNonEmpty(branch?.city, matchedEmp?.branch_city, matchedEmp?.branchCity);
			const state = firstNonEmpty(branch?.state, matchedEmp?.branch_state, matchedEmp?.branchState);
			const zip = firstNonEmpty(branch?.zipCode, branch?.zip, matchedEmp?.branch_zip, matchedEmp?.branchZip);
			const street = firstNonEmpty(branch?.street1, branch?.street, matchedEmp?.branch_address, matchedEmp?.branchAddress, matchedEmp?.address);
			const addressParts = [street, [city, state].filter(Boolean).join(', '), zip].filter(Boolean);
			const otherNamesRaw = toArraySafe(src.ind_other_names).length ? src.ind_other_names : toArraySafe(src.otherNames);
			const otherNames = otherNamesRaw.map((n: unknown) => String(n || '').trim()).filter(Boolean);
			entries.push({
				individualId: personCrd,
				name: personName,
				relationship: personIsCurrent ? 'Current registration' : 'Previous registration',
				startDate: firstNonEmpty(matchedEmp?.registrationBeginDate, matchedEmp?.startDate) || undefined,
				endDate: personIsCurrent ? undefined : firstNonEmpty(matchedEmp?.registrationEndDate, matchedEmp?.endDate) || undefined,
				isCurrent: personIsCurrent,
				evidence: [evidenceTag, personIsCurrent ? 'current-employment-record' : 'matched-previous-employment'],
				bcScope: firstNonEmpty(src.ind_bc_scope, src.bcScope) || undefined,
				iaScope: firstNonEmpty(src.ind_ia_scope, src.iaScope) || undefined,
				otherNames: otherNames.length ? Array.from(new Set(otherNames)) : undefined,
				address: addressParts.length ? addressParts.join(' ') : undefined,
			});
		}

		const relatedEmployments = [
			...currentAtQuery.map((entry) => ({ entry, isCurrent: true })),
			...previousAtQuery.map((entry) => ({ entry, isCurrent: false })),
		];
		for (const { entry, isCurrent } of relatedEmployments) {
			const relatedId = employmentFirmId(entry);
			if (!relatedId || relatedId === query) continue;
			const key = `${relatedId}:${isCurrent ? '1' : '0'}`;
			if (seenFirm.has(key)) continue;
			seenFirm.add(key);
			entries.push({
				firmId: relatedId,
				name: employmentFirmName(entry) || `Firm ${relatedId}`,
				relationship: isCurrent ? 'Associated firm' : 'Previously associated firm',
				startDate: firstNonEmpty(entry?.registrationBeginDate, entry?.startDate) || undefined,
				endDate: isCurrent ? undefined : firstNonEmpty(entry?.registrationEndDate, entry?.endDate) || undefined,
				isCurrent,
				evidence: [evidenceTag, 'name-associated-firm'],
			});
		}
	}

	return entries;
}

async function fetchJson(url: string, referer: string): Promise<any | null> {
	try {
		const res = await fetch(url, {
			cache: 'no-store',
			headers: { ...SEARCH_HEADERS, Referer: referer },
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor++;
			out[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
	return out;
}

async function fetchAllOfficialHits(source: 'finra' | 'sec', firmId: string): Promise<{ hits: any[]; total: number }> {
	const referer = source === 'finra' ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/';
	const first = await fetchJson(officialSearchUrl(source, firmId, 0), referer);
	const firstHits = toArraySafe(first?.hits?.hits);
	const total = numericTotal(first?.hits?.total) || firstHits.length;
	if (!firstHits.length) return { hits: [], total: 0 };

	const starts: number[] = [];
	for (let start = OFFICIAL_SEARCH_PAGE_SIZE; start < total; start += OFFICIAL_SEARCH_PAGE_SIZE) {
		starts.push(start);
	}
	if (!starts.length) return { hits: firstHits, total };

	const pages = await mapPool(starts, OFFICIAL_SEARCH_PAGE_CONCURRENCY, async (start) => {
		const data = await fetchJson(officialSearchUrl(source, firmId, start), referer);
		return toArraySafe(data?.hits?.hits);
	});
	return { hits: firstHits.concat(pages.flat()), total };
}

function readLocalOfficialSearchFallback(source: 'finra' | 'sec', firmId: string): any[] {
	try {
		const fs = require('fs');
		const path = require('path');
		const domain = source === 'finra' ? 'brokercheck.finra.org' : 'adviserinfo.sec.gov';
		const host = source === 'finra' ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov';
		const candidates = [
			path.join(process.cwd(), 'data', 'national', domain, `${host}_search_individual_firm_${firmId}.json`),
			path.join(process.cwd(), 'data', 'national', domain, `${host}_search_firm_${firmId}.json`),
		];
		for (const filePath of candidates) {
			if (!fs.existsSync(filePath)) continue;
			const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			const hits = parsed?.hits?.hits;
			if (Array.isArray(hits) && hits.length) return hits;
		}
	} catch {
		// best-effort
	}
	return [];
}

export function isOfficialFirmRoster(payload: { source?: string; officialTotals?: unknown } | null | undefined): boolean {
	if (!payload || typeof payload !== 'object') return false;
	return payload.source === OFFICIAL_FIRM_ROSTER_SOURCE || Boolean(payload.officialTotals);
}

export async function fetchOfficialFirmRoster(firmId: string): Promise<OfficialFirmRoster | null> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return null;

	const [finra, sec] = await Promise.all([
		fetchAllOfficialHits('finra', normalizedFirmId).catch(() => ({ hits: [] as any[], total: 0 })),
		fetchAllOfficialHits('sec', normalizedFirmId).catch(() => ({ hits: [] as any[], total: 0 })),
	]);

	let finraHits = finra.hits;
	let secHits = sec.hits;
	if (!finraHits.length) finraHits = readLocalOfficialSearchFallback('finra', normalizedFirmId);
	if (!secHits.length) secHits = readLocalOfficialSearchFallback('sec', normalizedFirmId);
	if (!finraHits.length && !secHits.length) return null;

	const merged = mergeOfficialEntries([
		mapOfficialSearchHitsToConnections(normalizedFirmId, finraHits, 'official-search-finra'),
		mapOfficialSearchHitsToConnections(normalizedFirmId, secHits, 'official-search-sec'),
	]);
	if (!merged.currentConnections.length && !merged.previousConnections.length) return null;

	return {
		...merged,
		source: OFFICIAL_FIRM_ROSTER_SOURCE,
		officialTotals: { finra: finra.total, sec: sec.total },
		fetchedAt: new Date().toISOString(),
	};
}
