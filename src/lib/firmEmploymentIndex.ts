// Full-Redis-scan reverse employment index, ported from the sibling `dashboard-crds` app's
// pages/api/_graphIndex.ts (buildFirmEmployeeIndex). Both apps share the same Upstash Redis
// instance; dashboard-crds achieves a genuine current+previous "connections over time" view by
// scanning every saved individual payload directly, rather than relying solely on the (often
// incomplete) firm-CRD search index / graph snapshot. This module mirrors that approach so the
// dashboard/graph in this repo can find previous employments even when the individual was never
// search-indexed or graph-linked under the target firm's CRD.
//
// The index is built once per warm serverless instance and cached in-memory, keyed by a cheap
// "signature" (total individual-key count) so it's rebuilt only when the underlying Redis data
// changes shape. This mirrors dashboard-crds's in-memory cachedIndex/cachedIndexPromise pattern.
//
// Throughput: Redis is shared with other applications. Full SCAN+MGET of every individual key
// (~15k+) is DISABLED by default. Opt in with FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1 only for
// offline/admin jobs — never for interactive request paths when other tenants share the DB.
import { getRedisClient, decompressPayload } from '@/lib/redisCache';

/** Full individual-key scan is expensive on shared Redis; off unless explicitly enabled. */
export function isFirmEmploymentFullScanEnabled(): boolean {
	return process.env.FINRA_FIRM_EMPLOYMENT_FULL_SCAN === '1';
}

export type EmploymentEdge = {
	personCrd: string;
	personName: string;
	isCurrent: boolean;
	city?: string;
	state?: string;
	startDate?: string;
	endDate?: string;
};

const INDIVIDUAL_KEY_PATTERNS = ['finra:individual:*', 'sec:individual:*'];
const SCAN_COUNT = 1000;
const MGET_BATCH_SIZE = 200;

type FirmEmployeeIndex = Map<string, EmploymentEdge[]>;

let cachedIndex: FirmEmployeeIndex | null = null;
let cachedSignature = '';
let cachedIndexPromise: Promise<FirmEmployeeIndex> | null = null;

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

// Unwraps the raw Redis payload shape (`{ hits: { hits: [{ _source: { content: "<json>" } }] } }`
// or a flatter already-parsed object) into the individual's basicInformation + employment arrays,
// mirroring parseDetailPayload() in src/app/api/finra/firm/[id]/route.ts.
// Supports brotli `br:` payloads written by redisCache.compressPayload after the binary cache change.
export function unwrapIndividualPayload(raw: unknown): any | null {
	let data: any = raw;
	if (typeof data === 'string') {
		try {
			const decompressed = decompressPayload(data);
			data = typeof decompressed === 'string' ? JSON.parse(decompressed) : decompressed;
		} catch {
			return null;
		}
	}
	if (!data) return null;

	const src = data?.hits?.hits?.length ? data.hits.hits[0]?._source : data;
	if (!src) return null;

	let parsed: any = {};
	const content = src.content;
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

async function scanAllKeys(redis: ReturnType<typeof getRedisClient>, pattern: string): Promise<string[]> {
	if (!redis) return [];
	const keys: string[] = [];
	let cursor = '0';
	do {
		const [next, batch] = await redis.scan(cursor, { match: pattern, count: SCAN_COUNT });
		cursor = String(next);
		keys.push(...(batch as string[]));
	} while (cursor !== '0');
	return keys;
}

function buildPersonName(basicInformation: any): string {
	if (!basicInformation) return '';
	return firstNonEmpty([basicInformation.firstName, basicInformation.middleName, basicInformation.lastName].filter(Boolean).join(' '));
}

function extractEdgesFromPayload(personCrd: string, payload: any): Map<string, EmploymentEdge[]> {
	const edgesByFirm = new Map<string, EmploymentEdge[]>();
	if (!payload) return edgesByFirm;

	const basicInformation = payload.basicInformation || {};
	const personName = buildPersonName(basicInformation);

	const currentEmployments = [...toArraySafe(payload.currentEmployments), ...toArraySafe(payload.currentIAEmployments)];
	const previousEmployments = [...toArraySafe(payload.previousEmployments), ...toArraySafe(payload.previousIAEmployments)];

	const addEdge = (entry: any, isCurrent: boolean) => {
		const firmId = firstNonEmpty(entry?.firmId, entry?.firm_id);
		if (!firmId) return;
		const edge: EmploymentEdge = {
			personCrd,
			personName,
			isCurrent,
			city: firstNonEmpty(entry?.city) || undefined,
			state: firstNonEmpty(entry?.state) || undefined,
			startDate: firstNonEmpty(entry?.registrationBeginDate) || undefined,
			endDate: firstNonEmpty(entry?.registrationEndDate) || undefined,
		};
		const list = edgesByFirm.get(firmId) || [];
		list.push(edge);
		edgesByFirm.set(firmId, list);
	};

	for (const entry of currentEmployments) addEdge(entry, true);
	for (const entry of previousEmployments) addEdge(entry, false);

	return edgesByFirm;
}

async function computeSignature(redis: ReturnType<typeof getRedisClient>): Promise<string> {
	if (!redis) return '';
	// Cheap-ish signature: total key count across both individual patterns. Recomputing this via
	// SCAN is fast (~1-2s total, per the finra:individual:* timing above) compared to the full
	// scan+mget+parse build, so it's a reasonable staleness check between requests within the same
	// warm instance.
	let total = 0;
	for (const pattern of INDIVIDUAL_KEY_PATTERNS) {
		const keys = await scanAllKeys(redis, pattern);
		total += keys.length;
	}
	return String(total);
}

async function buildFirmEmployeeIndex(): Promise<FirmEmployeeIndex> {
	const redis = getRedisClient();
	const index: FirmEmployeeIndex = new Map();
	if (!redis) return index;

	for (const pattern of INDIVIDUAL_KEY_PATTERNS) {
		const keys = await scanAllKeys(redis, pattern);
		for (let i = 0; i < keys.length; i += MGET_BATCH_SIZE) {
			const batch = keys.slice(i, i + MGET_BATCH_SIZE);
			let values: unknown[];
			try {
				values = await redis.mget(...batch);
			} catch {
				continue;
			}
			for (let j = 0; j < batch.length; j++) {
				const key = batch[j];
				const raw = values[j];
				if (!raw) continue;
				const personCrd = key.replace(/^(finra|sec):individual:/, '');
				const payload = unwrapIndividualPayload(raw);
				if (!payload) continue;

				const edgesByFirm = extractEdgesFromPayload(personCrd, payload);
				for (const [firmId, edges] of edgesByFirm) {
					const existing = index.get(firmId) || [];
					existing.push(...edges);
					index.set(firmId, existing);
				}
			}
		}
	}

	return index;
}

async function getFirmEmployeeIndex(): Promise<FirmEmployeeIndex> {
	const redis = getRedisClient();
	if (!redis) return cachedIndex || new Map();

	const signature = await computeSignature(redis).catch(() => '');
	if (cachedIndex && signature && signature === cachedSignature) return cachedIndex;

	if (!cachedIndexPromise) {
		cachedIndexPromise = buildFirmEmployeeIndex()
			.then((index) => {
				cachedIndex = index;
				cachedSignature = signature;
				return index;
			})
			.finally(() => {
				cachedIndexPromise = null;
			});
	}

	return cachedIndexPromise;
}

// Returns every current + previous employment edge for the given firm CRD, found by scanning ALL
// saved individual payloads in Redis (regardless of search-index coverage). Deduplicated by
// personCrd+isCurrent, mirroring dashboard-crds's seenPersonFirm Set.
//
// No-ops unless FINRA_FIRM_EMPLOYMENT_FULL_SCAN=1 to keep shared-Redis throughput low.
export async function getFirmEmploymentEdgesFromFullScan(firmId: string): Promise<EmploymentEdge[]> {
	const normalizedFirmId = String(firmId || '').trim();
	if (!normalizedFirmId) return [];
	if (!isFirmEmploymentFullScanEnabled()) return [];

	try {
		const index = await getFirmEmployeeIndex();
		const edges = index.get(normalizedFirmId) || [];
		const seen = new Set<string>();
		const deduped: EmploymentEdge[] = [];
		for (const edge of edges) {
			const key = `${edge.personCrd}:${edge.isCurrent}`;
			if (seen.has(key)) continue;
			seen.add(key);
			deduped.push(edge);
		}
		return deduped;
	} catch {
		return [];
	}
}
