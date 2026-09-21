import { getFullGraph } from '@/lib/graphStore';
import type { LocalSearchEntity, LocalSearchResponse, LocalSearchSource } from '@/lib/localSearch';

type SearchFallbackOptions = {
	limit?: number;
	offset?: number;
};

const STRICT_MATCH_QUERY_ALLOWLIST = new Set(['mason', 'bryan']);

function normalizeText(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function containsWholePhrase(text: string, phrase: string) {
	if (!text || !phrase) return false;
	return ` ${text} `.includes(` ${phrase} `);
}

function isIdentifierLikeQuery(value: string) {
	return /^[0-9-]+$/.test(value);
}

function isStrictMatchQuery(value: string) {
	return STRICT_MATCH_QUERY_ALLOWLIST.has(value);
}

function collectAliasLikeValues(...sources: unknown[]) {
	const collected: string[] = [];
	for (const source of sources) {
		if (source == null) continue;
		const values = Array.isArray(source) ? source : [source];
		for (const value of values) {
			if (value == null) continue;
			const text = String(value).trim();
			if (!text) continue;
			collected.push(text);
		}
	}
	return collected;
}

function collectExactAddressValues(node: any) {
	const basic = node?.basicInformation || {};
	const exactValues = [
		node?.address,
		node?.addressSearchText,
		basic?.address,
		basic?.state,
		basic?.street1,
		basic?.street2,
		node?.state,
		node?.street1,
		node?.street2,
		...(Array.isArray(node?.currentEmployments) ? node.currentEmployments.flatMap((job: any) => [job?.state, job?.city]) : []),
		...(Array.isArray(node?.previousEmployments) ? node.previousEmployments.flatMap((job: any) => [job?.state, job?.city]) : []),
	];
	return collectAliasLikeValues(...exactValues);
}

export function collectSearchableNodeKeys(node: any) {
	const basic = node?.basicInformation || {};
	const group = node?.group || (node?.type === 'firm' || node?.firmId || node?.firm_id ? 'firm' : 'individual');
	const aliasValues = collectAliasLikeValues(
		Array.isArray(node?.otherNames) ? node.otherNames : [],
		Array.isArray(basic?.otherNames) ? basic.otherNames : [],
		Array.isArray(node?.aliases) ? node.aliases : [],
		Array.isArray(basic?.aliases) ? basic.aliases : [],
		Array.isArray(node?.previousNames) ? node.previousNames : [],
		Array.isArray(basic?.previousNames) ? basic.previousNames : [],
		Array.isArray(node?.aka) ? node.aka : [],
		Array.isArray(basic?.aka) ? basic.aka : [],
		Array.isArray(node?.formerNames) ? node.formerNames : [],
		Array.isArray(basic?.formerNames) ? basic.formerNames : [],
		Array.isArray(node?.dbaNames) ? node.dbaNames : [],
		Array.isArray(basic?.dbaNames) ? basic.dbaNames : [],
	);
	if (group === 'firm') {
		return [
			node?.id,
			node?.label,
			node?.name,
			node?.crd,
			node?.firmId,
			node?.bdSecNumber,
			node?.iaSecNumber,
			basic?.firmId,
			basic?.name,
			basic?.bdSECNumber,
			basic?.iaSECNumber,
			...aliasValues,
			node?.firm_source_id,
		]
			.map((value) => normalizeText(value))
			.filter(Boolean);
	}
	return [
		node?.id,
		node?.label,
		node?.name,
		node?.crd,
		node?.firmId,
		node?.bdSecNumber,
		node?.iaSecNumber,
		basic?.individualId,
		basic?.firmId,
		basic?.name,
		basic?.bdSECNumber,
		basic?.iaSECNumber,
		[basic?.firstName, basic?.middleName, basic?.lastName].filter(Boolean).join(' '),
		...aliasValues,
		node?.ind_source_id,
		node?.firm_source_id,
	]
		.map((value) => normalizeText(value))
		.filter(Boolean);
}

function getBoundedEditDistance(left: string, right: string, maxDistance: number) {
	if (left === right) return 0;
	if (!left || !right) return maxDistance + 1;
	if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		let rowMin = current[0];
		for (let col = 1; col <= right.length; col += 1) {
			const cost = left[row - 1] === right[col - 1] ? 0 : 1;
			const nextValue = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost);
			current[col] = nextValue;
			if (nextValue < rowMin) rowMin = nextValue;
		}
		if (rowMin > maxDistance) return maxDistance + 1;
		previous = current;
	}
	return previous[right.length];
}

function tokensFuzzyMatch(queryToken: string, candidateToken: string) {
	if (!queryToken || !candidateToken) return false;
	if (queryToken === candidateToken) return true;
	if (isIdentifierLikeQuery(queryToken) || isIdentifierLikeQuery(candidateToken)) return false;
	if (candidateToken.includes(queryToken) && queryToken.length >= 4) return true;
	if (queryToken.includes(candidateToken) && candidateToken.length >= 4) return true;
	const minLength = Math.min(queryToken.length, candidateToken.length);
	if (minLength < 4) return false;
	const maxDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
	return getBoundedEditDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

export function matchesSearchableNodeQuery(node: any, query: string) {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery) return false;
	const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
	const keys = collectSearchableNodeKeys(node);
	const exactAddressTerms = collectExactAddressValues(node).map((value) => normalizeText(value));
	const identifierLikeQuery = isIdentifierLikeQuery(normalizedQuery);
	const strictQuery = isStrictMatchQuery(normalizedQuery);
	if (exactAddressTerms.some((term) => term === normalizedQuery || containsWholePhrase(term, normalizedQuery))) return true;
	if (keys.some((key) => key === normalizedQuery || containsWholePhrase(key, normalizedQuery))) return true;
	if (strictQuery) {
		return (
			queryTokens.length > 0 &&
			keys.some((key) => {
				const keyTokens = key.split(/\s+/).filter(Boolean);
				return queryTokens.every((qt) => keyTokens.some((kt) => kt === qt));
			})
		);
	}
	if (!identifierLikeQuery && keys.some((key) => key.includes(normalizedQuery))) return true;
	if (queryTokens.length > 0) {
		for (const key of keys) {
			const keyTokens = key.split(/\s+/).filter(Boolean);
			if (queryTokens.every((qt) => keyTokens.some((kt) => tokensFuzzyMatch(qt, kt)))) {
				return true;
			}
		}

		// If the user supplied multiple words (e.g., first + last), also allow
		// non-contiguous matches where the first and last query tokens appear in
		// the candidate key in order (possibly with a middle name/initial between
		// them). This enables matching "John Doe" to "John A. Doe" or
		// "Doe, John A" (we check both orders).
		if (queryTokens.length >= 2) {
			const firstQt = queryTokens[0];
			const lastQt = queryTokens[queryTokens.length - 1];
			for (const key of keys) {
				const keyTokens = key.split(/\s+/).filter(Boolean);
				const firstMatches: number[] = [];
				const lastMatches: number[] = [];
				for (let i = 0; i < keyTokens.length; i++) {
					if (tokensFuzzyMatch(firstQt, keyTokens[i])) firstMatches.push(i);
					if (tokensFuzzyMatch(lastQt, keyTokens[i])) lastMatches.push(i);
				}
				// check forward order (first before last) with small allowance for a
				// single extra token (middle name/initial) in between.
				for (const i of firstMatches) {
					for (const j of lastMatches) {
						if (i < j && j - i <= 4) return true;
						// also accept reversed order ("Last, First") if both match.
						if (j < i && i - j <= 2) return true;
					}
				}
			}
		}
	}
	return false;
}

function compareNodes(left: any, right: any, query: string) {
	const normalizedQuery = normalizeText(query);
	const leftKeys = collectSearchableNodeKeys(left);
	const rightKeys = collectSearchableNodeKeys(right);
	const leftExact =
		leftKeys.some((key) => key === normalizedQuery) ? 2
		: leftKeys.some((key) => containsWholePhrase(key, normalizedQuery)) ? 1
		: 0;
	const rightExact =
		rightKeys.some((key) => key === normalizedQuery) ? 2
		: rightKeys.some((key) => containsWholePhrase(key, normalizedQuery)) ? 1
		: 0;
	if (rightExact !== leftExact) return rightExact - leftExact;
	return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export async function searchGraphFallback(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: SearchFallbackOptions = {}): Promise<LocalSearchResponse> {
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const graph = await getFullGraph();
	const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const group = type === 'firm' ? 'firm' : 'individual';
	const matches = nodes.filter((node) => node?.group === group && matchesSearchableNodeQuery(node, query)).sort((left, right) => compareNodes(left, right, query));
	const pageNodes = limit > 0 ? matches.slice(offset, offset + limit) : [];
	return {
		bucket: `${source}:${type}`,
		generatedAt: null,
		total: matches.length,
		hits: {
			total: matches.length,
			start: offset,
			hits: pageNodes.map((node) => ({ _id: String(node?.id || ''), _source: node })),
		},
		response: {
			numFound: matches.length,
			start: offset,
			docs: pageNodes,
		},
		results: pageNodes,
		currentPage: pageNodes,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}
