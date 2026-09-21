import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import { compressPayload, decompressPayload, getRedisClient } from '@/lib/redisCache';
import { canWriteToRedis, isRedisCacheOnly } from '@/lib/redisAvailability';

// Individuals who are scraped-only references (e.g. FINRA/SEC firm-page "Direct Owners &
// Executive Officers" entries) frequently have no independent, searchable BrokerCheck/IAPD
// record of their own. This module maintains a lightweight reverse index — keyed by the
// individual's CRD — so `/api/finra/individual/[crd]` can recognize these "orphan" CRDs and
// surface the scraped name/position/firm metadata instead of a bare "not found" response.

const OWNER_REF_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type OwnerReference = {
	crd: string;
	name?: string;
	position?: string;
	firmName?: string;
	parentCrd: string;
	parentType: 'firm' | 'individual';
	officeAddress?: Record<string, unknown>;
	mailingAddress?: Record<string, unknown>;
	phone?: string;
	firmStatus?: string;
	status?: string;
};

// Primary local namespace for scraped/non-live CRDs surfaced as orphan references.
function nonLiveReferenceKey(kind: 'individual' | 'firm', crd: string): string {
	return `non-live-crds:${kind}:${String(crd).trim()}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isOrphanPayload(value: unknown): value is { orphan: OwnerReference; sources?: Record<string, unknown> } {
	if (!isPlainObject(value)) return false;
	if (isPlainObject(value.orphan)) return true;
	return Boolean(value.found === false && value.orphan && isPlainObject(value.orphan));
}

function parseRedisReference(raw: unknown): OwnerReference | null {
	if (raw == null) return null;
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		const unwrapped = raw.startsWith('br:') ? decompressPayload(raw) : raw;
		try {
			parsed = JSON.parse(unwrapped);
		} catch {
			return null;
		}
	}
	if (isOrphanPayload(parsed)) return parsed.orphan as OwnerReference;
	if (isPlainObject(parsed)) return parsed as OwnerReference;
	return null;
}

function getRootLevelKeys(kind: 'individual' | 'firm', crd: string): string[] {
	if (kind === 'individual') return [`finra:individual:${crd}`, `sec:individual:${crd}`];
	return [`finra:firm:${crd}`, `sec:firm:${crd}`];
}

function createOrphanPayload(reference: OwnerReference) {
	return {
		found: true,
		crd: reference.crd,
		orphan: reference,
		sources: {
			finra: { found: false },
			sec: { found: false },
		},
		hasFinraData: false,
		hasSecData: false,
	};
}

function looksLikeLiveCrdPayload(kind: 'individual' | 'firm', value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	const hits = record.hits;
	if (isPlainObject(hits) && Array.isArray(hits.hits) && hits.hits.length > 0) return true;
	if (kind === 'individual') {
		return Boolean(record.basicInformation || record.individualId || record.crdNumber || record.name);
	}
	return Boolean(record.basicInformation || record.firmId || record.firmName || record.name);
}

function hasLocalLiveCrdRecord(kind: 'individual' | 'firm', crd: string): boolean {
	const root = path.join(process.cwd(), 'data', 'national');
	const fileCandidates = kind === 'individual'
		? [
			path.join(root, 'brokercheck.finra.org', `api.brokercheck.finra.org_search_individual_${crd}.json`),
			path.join(root, 'adviserinfo.sec.gov', `api.adviserinfo.sec.gov_search_individual_${crd}.json`),
		]
		: [
			path.join(root, 'brokercheck.finra.org', `api.brokercheck.finra.org_search_firm_${crd}.json`),
			path.join(root, 'adviserinfo.sec.gov', `api.adviserinfo.sec.gov_search_firm_${crd}.json`),
		];

	for (const filePath of fileCandidates) {
		try {
			const raw = readFileSync(filePath, 'utf8');
			if (!raw || !raw.trim()) continue;
			const parsed = JSON.parse(raw);
			if (parsed == null || typeof parsed !== 'object') continue;

			const record = parsed as Record<string, unknown>;
			const hits = record.hits;
			if (isPlainObject(hits) && Array.isArray(hits.hits) && hits.hits.length > 0) {
				const first = hits.hits[0] as Record<string, unknown> | undefined;
				const source = first?._source as Record<string, unknown> | undefined;
				const content = source?.content ?? source?.iacontent;
				if (typeof content === 'string') {
					const payload = JSON.parse(content);
					if (looksLikeLiveCrdPayload(kind, payload)) return true;
				}
				if (looksLikeLiveCrdPayload(kind, source)) return true;
			}

			if (looksLikeLiveCrdPayload(kind, parsed)) return true;
		} catch {
			// Empty/invalid local cache is not evidence of a live CRD.
		}
	}

	return false;
}

async function hasLiveCrdDetail(kind: 'individual' | 'firm', crd: string): Promise<boolean> {
	if (hasLocalLiveCrdRecord(kind, crd)) return true;

	const redis = getRedisClient();
	if (redis) {
		const keys = kind === 'individual'
			? [`finra:individual:${crd}`, `sec:individual:${crd}`]
			: [`finra:firm:${crd}`, `sec:firm:${crd}`, `finra:firm:summaryHtml:${crd}`, `sec:firm:summaryHtml:${crd}`];
		for (const key of keys) {
			try {
				const value = await redis.get(key);
				if (value == null || value === '') continue;
				const parsed = parseRedisReference(value);
				if (isOrphanPayload(value) || isOrphanPayload(parsed)) continue;
				return true;
			} catch {
				// Ignore lookup failures and fall back to the remote check below.
			}
		}
	}

	return false;
}

async function clearStoredOwnerReference(kind: 'individual' | 'firm', crd: string): Promise<void> {
	const redis = getRedisClient();
	if (redis) {
		try {
			// Primary namespace plus legacy owner-ref:* (retired — do not write it again).
			await redis.del(nonLiveReferenceKey(kind, crd), `owner-ref:${kind}:${crd}`);
		} catch {
			// ignore cleanup failures
		}
	}
}

/** Best-effort, non-blocking write. Never throws — callers should fire-and-forget this. */
export async function recordOwnerReference(reference: OwnerReference): Promise<void> {
	const crd = String(reference.crd || '').trim();
	if (!/^\d{1,10}$/.test(crd)) return;

	try {
		if (await hasLiveCrdDetail('individual', crd)) {
			await clearStoredOwnerReference('individual', crd);
			return;
		}
		const redis = getRedisClient();
		if (redis && canWriteToRedis()) {
			const payload = createOrphanPayload(reference);
			await redis.set(nonLiveReferenceKey('individual', crd), compressPayload(JSON.stringify(payload)), { ex: OWNER_REF_TTL_SECONDS });
		}
	} catch {
		// swallow: this is a best-effort index, never allow it to break the firm fetch response
	}
}

/**
 * Records owner-reference entries for every direct/indirect owner of a firm that carries a
 * numeric CRD. Intended to be called (fire-and-forget) whenever a firm detail payload is
 * built, so subsequent individual lookups for these CRDs can resolve as orphan records.
 */
export async function recordOwnerReferencesForFirm(params: {
	parentCrd: string;
	firmName?: string;
	officeAddress?: Record<string, unknown>;
	mailingAddress?: Record<string, unknown>;
	phone?: string;
	firmStatus?: string;
	owners: Array<Record<string, unknown>>;
}): Promise<void> {
	const parentCrd = String(params.parentCrd || '').trim();
	if (!parentCrd || !Array.isArray(params.owners) || !params.owners.length) return;

	const writes: Promise<void>[] = [];
	for (const owner of params.owners) {
		if (!isPlainObject(owner)) continue;
		const bcScope = String(owner.bcScope ?? owner.bc_scope ?? owner.scope ?? '').trim().toLowerCase();
		if (!bcScope || bcScope !== 'notinscope') continue;
		const crd = String(owner.crdNumber ?? owner.crd ?? owner.individualId ?? '').trim();
		if (!/^\d{1,10}$/.test(crd)) continue;

		writes.push(
			recordOwnerReference({
				crd,
				name: typeof owner.legalName === 'string' ? owner.legalName : typeof owner.name === 'string' ? owner.name : undefined,
				position: typeof owner.position === 'string' ? owner.position : typeof owner.title === 'string' ? owner.title : undefined,
				firmName: params.firmName,
				parentCrd,
				parentType: 'firm',
				officeAddress: params.officeAddress,
				mailingAddress: params.mailingAddress,
				phone: params.phone,
				firmStatus: typeof params.firmStatus === 'string' ? params.firmStatus : undefined,
			}),
		);
	}

	await Promise.allSettled(writes);
}

export async function lookupOwnerReference(crd: string): Promise<OwnerReference | null> {
	const normalizedCrd = String(crd || '').trim();
	if (!/^\d{1,10}$/.test(normalizedCrd)) return null;
	if (isRedisCacheOnly()) return null;

	try {
		const redis = getRedisClient();
		if (!redis) return null;

		const primaryKey = nonLiveReferenceKey('individual', normalizedCrd);
		try {
			const raw = await redis.get(primaryKey);
			const parsed = parseRedisReference(raw);
			if (parsed) return parsed;
		} catch {
			// ignore lookup failure
		}

		return null;
	} catch {
		return null;
	}
}

// Reciprocal case: firms that are scraped-only references (e.g. a firm CRD/name that appears
// only in an individual's current/previous employment history — such as one scraped directly
// from that person's BrokerCheck summary page — with no independent, searchable
// BrokerCheck/IAPD firm record of their own). This mirrors the individual owner-reference index
// above but keyed by the firm's CRD, so `/api/finra/firm/[id]` can recognize these "orphan" firm
// CRDs and surface the scraped firm name/address metadata instead of a bare "not found" response.

async function hasPublishedFirmDetailPage(crd: string): Promise<boolean> {
	return false;
}

async function hasLiveFirmDetail(crd: string): Promise<boolean> {
	const redis = getRedisClient();
	if (redis) {
		for (const key of [
			`finra:firm:${crd}`,
			`sec:firm:${crd}`,
			`finra:firm:summaryHtml:${crd}`,
			`sec:firm:summaryHtml:${crd}`,
		]) {
			try {
				const value = await redis.get(key);
				if (value != null && value !== '') return true;
			} catch {
				// Best-effort check; move on to the next candidate key if a read fails.
			}
		}
	}

	return await hasPublishedFirmDetailPage(crd);
}

/** Best-effort, non-blocking write. Never throws — callers should fire-and-forget this. */
export async function recordFirmReference(reference: OwnerReference): Promise<void> {
	const crd = String(reference.crd || '').trim();
	if (!/^\d{1,10}$/.test(crd)) return;

	try {
		if (await hasLiveCrdDetail('firm', crd)) {
			await clearStoredOwnerReference('firm', crd);
			return;
		}
		const redis = getRedisClient();
		if (redis && canWriteToRedis()) {
			const payload = createOrphanPayload(reference);
			await redis.set(nonLiveReferenceKey('firm', crd), compressPayload(JSON.stringify(payload)), { ex: OWNER_REF_TTL_SECONDS });
		}
	} catch {
		// swallow: this is a best-effort index, never allow it to break the individual fetch response
	}
}

/**
 * Records firm-reference entries for every employer with a numeric firmId found in an
 * individual's employment history. Intended to be called (fire-and-forget) whenever an
 * individual detail payload is built, so subsequent firm lookups for these CRDs can resolve
 * as orphan records.
 */
export async function recordFirmReferencesForIndividual(params: { parentCrd: string; individualName?: string; employments: Array<Record<string, unknown>> }): Promise<void> {
	const parentCrd = String(params.parentCrd || '').trim();
	if (!parentCrd || !Array.isArray(params.employments) || !params.employments.length) return;

	const seen = new Set<string>();
	const writes: Promise<void>[] = [];
	for (const employment of params.employments) {
		if (!isPlainObject(employment)) continue;
		const crd = String((employment as Record<string, unknown>).firmId ?? (employment as Record<string, unknown>).firm_id ?? '').trim();
		if (!/^\d{1,10}$/.test(crd) || seen.has(crd)) continue;
		seen.add(crd);

		const branches = (employment as Record<string, unknown>).branchOfficeLocations;
		const branch = Array.isArray(branches) && isPlainObject(branches[0]) ? (branches[0] as Record<string, unknown>) : null;
		const officeAddress =
			branch ?
				{
					street1: branch.street1,
					street2: branch.street2,
					city: branch.city,
					state: branch.state,
					postalCode: branch.zipCode,
					country: branch.country,
				}
			:	undefined;

		writes.push(
			recordFirmReference({
				crd,
				firmName: typeof (employment as Record<string, unknown>).firmName === 'string' ? ((employment as Record<string, unknown>).firmName as string) : undefined,
				name: params.individualName,
				parentCrd,
				parentType: 'individual',
				officeAddress,
			}),
		);
	}

	await Promise.allSettled(writes);
}

export async function lookupFirmReference(crd: string): Promise<OwnerReference | null> {
	const normalizedCrd = String(crd || '').trim();
	if (!/^\d{1,10}$/.test(normalizedCrd)) return null;
	if (isRedisCacheOnly()) return null;

	try {
		if (await hasLiveCrdDetail('firm', normalizedCrd)) {
			await clearStoredOwnerReference('firm', normalizedCrd);
			return null;
		}
		const redis = getRedisClient();
		if (!redis) return null;
		const raw = await redis.get(nonLiveReferenceKey('firm', normalizedCrd));
		const parsed = parseRedisReference(raw);
		if (parsed) return parsed;
		return null;
	} catch {
		return null;
	}
}
