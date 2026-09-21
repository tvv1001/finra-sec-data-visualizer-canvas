import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';

export type EmployerFirmLink = {
	firmId: string;
	firmName: string;
	isCurrent: boolean;
};

export type FirmConnectionCounts = {
	firmId: string;
	firmName?: string;
	currentCount: number;
	previousCount: number;
	total: number;
};

export type FirmConnectionSnapshot = {
	individualCrd: string;
	updatedAt: string;
	firms: Record<string, FirmConnectionCounts>;
};

export type BidirectionalValidationResult = {
	individualCrd: string;
	employers: EmployerFirmLink[];
	counts: Record<string, FirmConnectionCounts>;
	missingOnFirm: Array<{ firmId: string; firmName: string }>;
	countChanges: Array<{
		firmId: string;
		firmName?: string;
		before: FirmConnectionCounts | null;
		after: FirmConnectionCounts;
	}>;
};

function asDetail(payload: any): any {
	return payload?.bccontent || payload?.finraNode || payload?.merged || payload;
}

export function extractEmployerFirmsFromIndividualPayload(payload: any): EmployerFirmLink[] {
	const detail = asDetail(payload);
	const rows = [
		...(Array.isArray(detail?.currentEmployments) ? detail.currentEmployments.map((r: any) => ({ ...r, __current: true })) : []),
		...(Array.isArray(detail?.currentIAEmployments) ? detail.currentIAEmployments.map((r: any) => ({ ...r, __current: true })) : []),
		...(Array.isArray(detail?.previousEmployments) ? detail.previousEmployments.map((r: any) => ({ ...r, __current: false })) : []),
		...(Array.isArray(detail?.previousIAEmployments) ? detail.previousIAEmployments.map((r: any) => ({ ...r, __current: false })) : []),
	];

	const byFirm = new Map<string, EmployerFirmLink>();
	for (const row of rows) {
		const firmId = String(row?.firmId ?? row?.firm_id ?? '').trim();
		if (!/^\d{1,10}$/.test(firmId)) continue;
		const existing = byFirm.get(firmId);
		const isCurrent = Boolean(row.__current) || existing?.isCurrent === true;
		byFirm.set(firmId, {
			firmId,
			firmName: String(row?.firmName || existing?.firmName || '').trim(),
			isCurrent,
		});
	}
	return [...byFirm.values()];
}

export function connectionEntryMatchesIndividual(entry: any, individualCrd: string): boolean {
	const id = String(entry?.individualId ?? entry?.id ?? entry?.crd ?? '').trim();
	return id === String(individualCrd).trim();
}

export function rosterIncludesIndividual(payload: any, individualCrd: string): boolean {
	const all = [...(payload?.currentConnections || []), ...(payload?.previousConnections || [])];
	return all.some((entry) => connectionEntryMatchesIndividual(entry, individualCrd));
}

export function countFirmConnections(payload: any, firmId: string, firmName?: string): FirmConnectionCounts {
	const currentCount = Array.isArray(payload?.currentConnections) ? payload.currentConnections.length : 0;
	const previousCount = Array.isArray(payload?.previousConnections) ? payload.previousConnections.length : 0;
	return {
		firmId: String(firmId),
		firmName,
		currentCount,
		previousCount,
		total: currentCount + previousCount,
	};
}

export function snapshotPathForIndividual(individualCrd: string): string {
	return path.resolve(process.cwd(), 'tests/e2e/fixtures', `firm-connection-counts.${individualCrd}.json`);
}

export function readConnectionSnapshot(individualCrd: string): FirmConnectionSnapshot | null {
	const file = snapshotPathForIndividual(individualCrd);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as FirmConnectionSnapshot;
	} catch {
		return null;
	}
}

export function writeConnectionSnapshot(snapshot: FirmConnectionSnapshot): void {
	const file = snapshotPathForIndividual(snapshot.individualCrd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export function diffConnectionCounts(
	before: FirmConnectionSnapshot | null,
	after: Record<string, FirmConnectionCounts>,
): BidirectionalValidationResult['countChanges'] {
	const changes: BidirectionalValidationResult['countChanges'] = [];
	const firmIds = new Set([...Object.keys(after), ...Object.keys(before?.firms || {})]);
	for (const firmId of firmIds) {
		const prev = before?.firms?.[firmId] || null;
		const next = after[firmId];
		if (!next) continue;
		if (
			!prev ||
			prev.currentCount !== next.currentCount ||
			prev.previousCount !== next.previousCount ||
			prev.total !== next.total
		) {
			changes.push({ firmId, firmName: next.firmName || prev?.firmName, before: prev, after: next });
		}
	}
	return changes;
}

/** Fetch light firm rosters and assert the person CRD appears on every employer firm. */
export async function validateIndividualEmployerBidirectionalRefs(
	request: APIRequestContext,
	individualCrd: string,
	options: { updateSnapshot?: boolean; maxFirms?: number } = {},
): Promise<BidirectionalValidationResult> {
	const indivRes = await request.get(`/api/finra/individual/${individualCrd}`);
	if (!indivRes.ok()) {
		throw new Error(`individual ${individualCrd} returned HTTP ${indivRes.status()}`);
	}
	const indivPayload = await indivRes.json();
	let employers = extractEmployerFirmsFromIndividualPayload(indivPayload);
	if (options.maxFirms && options.maxFirms > 0) {
		employers = employers.slice(0, options.maxFirms);
	}
	if (!employers.length) {
		throw new Error(`individual ${individualCrd} has no employer firm CRDs to validate`);
	}

	const counts: Record<string, FirmConnectionCounts> = {};
	const missingOnFirm: Array<{ firmId: string; firmName: string }> = [];

	// Sequential light fetches keep Redis pressure low and avoid mega-firm enrichment.
	for (const employer of employers) {
		const connRes = await request.get(`/api/finra/firm/${employer.firmId}/connections?light=1`);
		if (!connRes.ok()) {
			missingOnFirm.push({ firmId: employer.firmId, firmName: employer.firmName });
			continue;
		}
		const connPayload = await connRes.json();
		const counted = countFirmConnections(connPayload, employer.firmId, employer.firmName);
		counts[employer.firmId] = counted;
		if (!rosterIncludesIndividual(connPayload, individualCrd)) {
			missingOnFirm.push({ firmId: employer.firmId, firmName: employer.firmName });
		}
	}

	const previous = readConnectionSnapshot(individualCrd);
	const countChanges = diffConnectionCounts(previous, counts);
	const shouldWriteSnapshot = Boolean(options.updateSnapshot) || process.env.UPDATE_FIRM_CONNECTION_SNAPSHOT === '1';
	if (shouldWriteSnapshot) {
		writeConnectionSnapshot({
			individualCrd,
			updatedAt: new Date().toISOString(),
			firms: counts,
		});
	}

	return {
		individualCrd,
		employers,
		counts,
		missingOnFirm,
		countChanges,
	};
}
