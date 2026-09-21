// Reverse firm → employee lookup.
// Prefer precomputed O(1) keys from scripts/build_firm_employment_adj.js:
//   graph:firm-emp-adj:v1:{firmId}
// Fallback: load multi-MB primed:bundle:finra-individual* once per warm instance.
// Used by firm /connections and expand when the mono session graph has no employed_by edges.
import type { Redis } from '@upstash/redis';
import zlib from 'node:zlib';
import { getRedisClientInstance } from '@/lib/redisClient';
import { decompressPayload } from '@/lib/redisCache';

export type PrimedEmploymentEdge = {
	personCrd: string;
	personName: string;
	isCurrent: boolean;
	startDate?: string;
	endDate?: string;
	bcScope?: string;
	iaScope?: string;
};

type PrimedBundle = Record<string, unknown>;

const BUNDLE_NAME = 'finra-individual';
const PRIMED_KEY = `primed:bundle:${BUNDLE_NAME}`;
const PRIMED_META_KEY = `${PRIMED_KEY}:meta`;
const FIRM_EMP_ADJ_PREFIX = 'graph:firm-emp-adj:v1';

let reverseIndex: Map<string, PrimedEmploymentEdge[]> | null = null;
let reverseIndexPromise: Promise<Map<string, PrimedEmploymentEdge[]>> | null = null;

function getRedis(): Redis | null {
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	return getRedisClientInstance({ url, token });
}

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

function decodeBundlePayload(raw: string): PrimedBundle | null {
	if (!raw) return null;
	try {
		if (raw.startsWith('br:')) {
			const text = decompressPayload(raw);
			return JSON.parse(text) as PrimedBundle;
		}
		const json = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
		return JSON.parse(json) as PrimedBundle;
	} catch {
		try {
			return JSON.parse(raw) as PrimedBundle;
		} catch {
			return null;
		}
	}
}

async function loadPrimedIndividualBundle(redis: Redis): Promise<PrimedBundle | null> {
	try {
		const single = await redis.get<string>(PRIMED_KEY);
		if (typeof single === 'string' && single) {
			const decoded = decodeBundlePayload(single);
			if (decoded) return decoded;
		}

		const rawMeta = await redis.get<string>(PRIMED_META_KEY);
		if (!rawMeta) return null;
		const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
		const chunkCount = Number(meta?.chunks || meta?.parts || 0);
		if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null;

		const parts = await Promise.all(Array.from({ length: chunkCount }, (_, index) => redis.get<string>(`${PRIMED_KEY}:part:${index}`)));
		if (parts.some((part) => part == null)) return null;
		return decodeBundlePayload(parts.join(''));
	} catch {
		return null;
	}
}

function unwrapIndividualRecord(raw: unknown): any | null {
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!data || typeof data !== 'object') return null;

	const src = data?.hits?.hits?.length ? data.hits.hits[0]?._source : data;
	if (!src) return null;

	let parsed: any = {};
	const content = src.content ?? src.iacontent;
	if (typeof content === 'string') {
		try {
			parsed = JSON.parse(content);
		} catch {
			parsed = {};
		}
	} else if (content && typeof content === 'object') {
		parsed = content;
	}

	return { ...src, ...parsed };
}

function personCrdFromBundleKey(key: string, payload: any): string {
	const fromKey = key.match(/individual:(\d{1,10})/i)?.[1] || '';
	return firstNonEmpty(payload?.basicInformation?.individualId, payload?.basicInformation?.ind_source_id, payload?.ind_source_id, payload?.ind_crd, payload?.crd, fromKey);
}

function personNameFromPayload(payload: any): string {
	const bi = payload?.basicInformation || {};
	return firstNonEmpty(
		[bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' '),
		[payload?.ind_firstname, payload?.ind_middlename, payload?.ind_lastname].filter(Boolean).join(' '),
		payload?.individualName,
		payload?.name,
		payload?.label,
	);
}

function buildReverseIndex(bundle: PrimedBundle): Map<string, PrimedEmploymentEdge[]> {
	const index = new Map<string, PrimedEmploymentEdge[]>();

	for (const [key, value] of Object.entries(bundle)) {
		const payload = unwrapIndividualRecord(value);
		if (!payload) continue;
		const personCrd = personCrdFromBundleKey(key, payload);
		if (!personCrd) continue;
		const personName = personNameFromPayload(payload);

		const currentEmployments = [
			...toArraySafe(payload.currentEmployments),
			...toArraySafe(payload.currentIAEmployments),
			...toArraySafe(payload.ind_current_employments),
			...toArraySafe(payload.ind_ia_current_employments),
		];
		const previousEmployments = [
			...toArraySafe(payload.previousEmployments),
			...toArraySafe(payload.previousIAEmployments),
			...toArraySafe(payload.ind_previous_employments),
			...toArraySafe(payload.ind_ia_previous_employments),
		];

		const add = (entry: any, isCurrent: boolean) => {
			const firmId = firstNonEmpty(entry?.firmId, entry?.firm_id);
			if (!firmId) return;
			const bi = payload?.basicInformation || {};
			const edge: PrimedEmploymentEdge = {
				personCrd,
				personName,
				isCurrent,
				startDate: firstNonEmpty(entry?.registrationBeginDate, entry?.startDate) || undefined,
				endDate: firstNonEmpty(entry?.registrationEndDate, entry?.endDate) || undefined,
				bcScope: firstNonEmpty(payload?.bcScope, bi.bcScope) || undefined,
				iaScope: firstNonEmpty(payload?.iaScope, bi.iaScope) || undefined,
			};
			const list = index.get(firmId) || [];
			list.push(edge);
			index.set(firmId, list);
		};

		for (const entry of currentEmployments) add(entry, true);
		for (const entry of previousEmployments) add(entry, false);
	}

	// Deduplicate per firm
	for (const [firmId, edges] of index) {
		const seen = new Set<string>();
		const deduped: PrimedEmploymentEdge[] = [];
		for (const edge of edges) {
			const k = `${edge.personCrd}:${edge.isCurrent}`;
			if (seen.has(k)) continue;
			seen.add(k);
			deduped.push(edge);
		}
		index.set(firmId, deduped);
	}

	return index;
}

async function getReverseIndex(): Promise<Map<string, PrimedEmploymentEdge[]>> {
	if (reverseIndex) return reverseIndex;
	if (reverseIndexPromise) return reverseIndexPromise;

	reverseIndexPromise = (async () => {
		const redis = getRedis();
		if (!redis) {
			reverseIndex = new Map();
			return reverseIndex;
		}
		const bundle = await loadPrimedIndividualBundle(redis);
		reverseIndex = bundle ? buildReverseIndex(bundle) : new Map();
		return reverseIndex;
	})().finally(() => {
		reverseIndexPromise = null;
	});

	return reverseIndexPromise;
}

function edgesFromAdjPayload(raw: unknown): PrimedEmploymentEdge[] | null {
	if (raw == null) return null;
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const text = data.startsWith('br:') ? decompressPayload(data) : data;
			data = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!data || typeof data !== 'object') return null;

	const current = toArraySafe(data.currentConnections ?? data.current);
	const previous = toArraySafe(data.previousConnections ?? data.previous);
	if (!current.length && !previous.length && !Array.isArray(data.currentConnections) && !Array.isArray(data.previousConnections)) {
		// Distinguish empty precomputed result from missing key shape.
		if (!('currentConnections' in data) && !('previousConnections' in data) && !('current' in data) && !('previous' in data)) {
			return null;
		}
	}

	const out: PrimedEmploymentEdge[] = [];
	const push = (entry: any, isCurrent: boolean) => {
		const personCrd = firstNonEmpty(entry?.individualId, entry?.personCrd, entry?.crd);
		if (!personCrd) return;
		out.push({
			personCrd,
			personName: firstNonEmpty(entry?.name, entry?.personName, entry?.label),
			isCurrent: entry?.isCurrent != null ? Boolean(entry.isCurrent) : isCurrent,
			startDate: firstNonEmpty(entry?.startDate, entry?.registrationBeginDate) || undefined,
			endDate: firstNonEmpty(entry?.endDate, entry?.registrationEndDate) || undefined,
			bcScope: firstNonEmpty(entry?.bcScope) || undefined,
			iaScope: firstNonEmpty(entry?.iaScope) || undefined,
		});
	};
	for (const entry of current) push(entry, true);
	for (const entry of previous) push(entry, false);
	return out;
}

async function getEdgesFromPrecomputedAdj(firmId: string): Promise<PrimedEmploymentEdge[] | null> {
	const redis = getRedis();
	if (!redis) return null;
	try {
		const raw = await redis.get(`${FIRM_EMP_ADJ_PREFIX}:${firmId}`);
		return edgesFromAdjPayload(raw);
	} catch {
		return null;
	}
}

export type FirmEmploymentLookupSource = 'adj' | 'bundle' | 'none';

export type FirmEmploymentLookup = {
	edges: PrimedEmploymentEdge[];
	source: FirmEmploymentLookupSource;
};

/**
 * Reverse-index lookup with provenance.
 * `adj` is the precomputed complete firm roster (including an authoritative empty list).
 * `bundle` is a partial scan of the primed individual snapshot and must not be treated as complete.
 */
export async function lookupFirmEmploymentEdgesFromPrimed(firmId: string): Promise<FirmEmploymentLookup> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return { edges: [], source: 'none' };
	try {
		const precomputed = await getEdgesFromPrecomputedAdj(normalizedFirmId);
		if (precomputed) return { edges: precomputed, source: 'adj' };

		const index = await getReverseIndex();
		if (!index.size) return { edges: [], source: 'none' };
		return { edges: index.get(normalizedFirmId) || [], source: 'bundle' };
	} catch {
		return { edges: [], source: 'none' };
	}
}

/** Returns current/previous employment edges for a firm (precomputed adj, then primed bundle). */
export async function getFirmEmploymentEdgesFromPrimed(firmId: string): Promise<PrimedEmploymentEdge[]> {
	return (await lookupFirmEmploymentEdgesFromPrimed(firmId)).edges;
}

/** Test helper — reset warm-instance cache. */
export function __resetFirmEmploymentFromPrimedCacheForTests() {
	reverseIndex = null;
	reverseIndexPromise = null;
}
