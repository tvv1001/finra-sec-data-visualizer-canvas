import { hasFirmSourceCoverage, hasIndividualSourceCoverage, isNotInScopeValue } from '@/lib/sourceTruth';

export type DashboardSource = 'finra' | 'sec';

const EMPLOYMENT_KEYS = ['currentEmployments', 'previousEmployments', 'currentIAEmployments', 'previousIAEmployments'] as const;

function isPlainObject(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapSourceContent(source: unknown, keys: string[]) {
	if (!isPlainObject(source)) return source;
	for (const key of keys) {
		if (isPlainObject(source[key])) return source[key];
	}
	return source;
}

export function countEmploymentRecords(payload: unknown) {
	if (!isPlainObject(payload)) return 0;
	return EMPLOYMENT_KEYS.reduce((total, key) => total + (Array.isArray(payload[key]) ? payload[key].length : 0), 0);
}

function collectEmploymentPayloads(detail: any) {
	return [
		detail?.merged,
		detail?.finraNode,
		unwrapSourceContent(detail?.sources?.sec, ['iacontent', 'content']),
		unwrapSourceContent(detail?.sources?.finra, ['bccontent', 'content']),
	].filter(isPlainObject);
}

function employmentRecordKey(row: unknown) {
	if (!isPlainObject(row)) return '';
	const firmId = String(row.firmId ?? row.firm_id ?? row.crdNumber ?? row.crd ?? '').trim();
	const start = String(row.registrationBeginDate ?? row.effectiveDate ?? row.startDate ?? '').trim();
	const end = String(row.registrationEndDate ?? row.endDate ?? '').trim();
	const name = String(row.firmName ?? row.firm_name ?? '')
		.trim()
		.toLowerCase();
	return `${firmId}|${start}|${end}|${name}`;
}

function employmentRecordRichness(row: unknown) {
	if (!isPlainObject(row)) return 0;
	return Object.values(row).filter((value) => value != null && value !== '' && !(Array.isArray(value) && value.length === 0)).length;
}

export function unionEmploymentRecords(...arrays: unknown[]) {
	const byKey = new Map<string, any>();
	let anonymous = 0;
	for (const array of arrays) {
		for (const item of Array.isArray(array) ? array : []) {
			if (!isPlainObject(item)) continue;
			const key = employmentRecordKey(item) || `anon:${anonymous++}:${JSON.stringify(item)}`;
			const existing = byKey.get(key);
			if (!existing || employmentRecordRichness(item) > employmentRecordRichness(existing)) {
				byKey.set(key, item);
			}
		}
	}
	return Array.from(byKey.values());
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseEmploymentDateMs(value: unknown) {
	const raw = String(value ?? '').trim();
	if (!raw) return null;
	const short = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (short) {
		const year = short[3].length === 2 ? 2000 + Number(short[3]) : Number(short[3]);
		return Date.UTC(year, Number(short[1]) - 1, Number(short[2]));
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

export function sortByMostRecentStartDate<T extends { startDate?: string }>(items: T[]): T[] {
	return items.slice().sort((left, right) => {
		const leftTime = parseEmploymentDateMs(left.startDate);
		const rightTime = parseEmploymentDateMs(right.startDate);
		if (leftTime == null && rightTime == null) return 0;
		if (leftTime == null) return 1;
		if (rightTime == null) return -1;
		return rightTime - leftTime;
	});
}

function datesWithinOneWeek(left: unknown, right: unknown) {
	const a = parseEmploymentDateMs(left);
	const b = parseEmploymentDateMs(right);
	if (a == null || b == null) return true;
	return Math.abs(a - b) <= WEEK_MS;
}

export function employmentFirmCrd(row: unknown) {
	if (!isPlainObject(row)) return '';
	return String(row.firmId ?? row.firm_id ?? row.crdNumber ?? row.crd ?? '').trim();
}

function employmentStartDate(row: unknown) {
	if (!isPlainObject(row)) return '';
	return row.registrationBeginDate ?? row.effectiveDate ?? row.startDate ?? '';
}

function employmentEndDate(row: unknown) {
	if (!isPlainObject(row)) return '';
	return row.registrationEndDate ?? row.endDate ?? '';
}

function withEmploymentSourceTag(row: Record<string, any>, source: 'FINRA' | 'SEC') {
	const tags = Array.from(new Set([...(Array.isArray(row.sourceTags) ? row.sourceTags : []), row.sourceTag, source].filter(Boolean)));
	return { ...row, sourceTag: tags.length === 1 ? tags[0] : row.sourceTag, sourceTags: tags };
}

function combineEmploymentCards(left: Record<string, any>, right: Record<string, any>) {
	const richer = employmentRecordRichness(right) > employmentRecordRichness(left) ? right : left;
	const other = richer === left ? right : left;
	const next: Record<string, any> = { ...other, ...richer };
	for (const [key, value] of Object.entries(other)) {
		if (next[key] == null || next[key] === '') next[key] = value;
	}
	next.sourceTags = Array.from(new Set([...(Array.isArray(left.sourceTags) ? left.sourceTags : []), ...(Array.isArray(right.sourceTags) ? right.sourceTags : [])]));
	if (next.sourceTags.length === 1) next.sourceTag = next.sourceTags[0];
	return next;
}

export function mergeEmploymentCardsAcrossSources(input: { finra?: unknown[]; sec?: unknown[]; extra?: unknown[] } | unknown[]) {
	const rows =
		Array.isArray(input) ? input.filter(isPlainObject)
		:	[
				...(Array.isArray(input.finra) ? input.finra.filter(isPlainObject).map((row) => withEmploymentSourceTag(row, 'FINRA')) : []),
				...(Array.isArray(input.sec) ? input.sec.filter(isPlainObject).map((row) => withEmploymentSourceTag(row, 'SEC')) : []),
				...(Array.isArray(input.extra) ? input.extra.filter(isPlainObject) : []),
			];

	const merged: Record<string, any>[] = [];
	for (const row of rows) {
		const crd = employmentFirmCrd(row);
		const matchIndex =
			crd ?
				merged.findIndex(
					(existing) =>
						employmentFirmCrd(existing) === crd &&
						datesWithinOneWeek(employmentStartDate(existing), employmentStartDate(row)) &&
						datesWithinOneWeek(employmentEndDate(existing), employmentEndDate(row)),
				)
			:	-1;
		if (matchIndex >= 0) {
			merged[matchIndex] = combineEmploymentCards(merged[matchIndex], row);
			continue;
		}
		merged.push(row);
	}
	return merged;
}

export function isEmptyNotInScopeSourceShell(payload: unknown, source: DashboardSource) {
	if (!isPlainObject(payload)) return true;
	const basic = isPlainObject(payload.basicInformation) ? payload.basicInformation : {};
	const scope = source === 'finra' ? (payload.bcScope ?? basic.bcScope) : (payload.iaScope ?? basic.iaScope);
	if (!isNotInScopeValue(scope)) return false;
	if (source === 'finra') return !hasIndividualSourceCoverage(payload, 'finra') && !hasFirmSourceCoverage(payload, 'finra');
	return !hasIndividualSourceCoverage(payload, 'sec') && !hasFirmSourceCoverage(payload, 'sec');
}

export function overlayMergedEmploymentHistory(payload: any, detail: any) {
	if (!isPlainObject(payload)) return payload;
	const sources = collectEmploymentPayloads(detail);
	if (!sources.length) return payload;

	let changed = false;
	const next = { ...payload };
	for (const key of EMPLOYMENT_KEYS) {
		const existing = Array.isArray(next[key]) ? next[key] : [];
		const unioned = unionEmploymentRecords(existing, ...sources.map((source) => source[key]));
		if (unioned.length === 0) continue;
		if (unioned.length !== existing.length || unioned.some((row, index) => row !== existing[index])) {
			next[key] = unioned;
			changed = true;
		}
	}
	return changed ? next : payload;
}

export function extractPayloadFromDetail(detail: any, source: DashboardSource) {
	if (!isPlainObject(detail)) return null;

	const hasOrphan = Boolean(detail?.orphan && typeof detail.orphan === 'object');
	const candidate =
		source === 'finra' ?
			(detail?.sources?.finra?.bccontent ?? detail?.sources?.finra?.content ?? detail?.sources?.finra ?? detail?.finraNode ?? detail?.merged ?? detail?.bccontent ?? null)
		:	(detail?.sources?.sec?.iacontent ?? detail?.sources?.sec?.content ?? detail?.sources?.sec ?? detail?.finraNode ?? detail?.merged ?? detail?.iacontent ?? null);

	const candidateHasIdentity =
		isPlainObject(candidate) &&
		candidate.found !== false &&
		(Boolean(candidate.basicInformation) ||
			Boolean(candidate.content) ||
			Boolean(candidate.iacontent) ||
			Boolean(candidate.hits) ||
			Boolean(candidate.individualId) ||
			Boolean(candidate.firmId) ||
			Boolean(candidate.firstName) ||
			Boolean(candidate.lastName) ||
			Boolean(candidate.legalName) ||
			Boolean(candidate.firmName));

	if (candidateHasIdentity && !isEmptyNotInScopeSourceShell(candidate, source)) {
		return overlayMergedEmploymentHistory(candidate, detail);
	}

	const merged = detail?.merged || detail?.finraNode;
	if (isPlainObject(merged) && countEmploymentRecords(merged) > 0) {
		return overlayMergedEmploymentHistory(merged, detail);
	}

	if (hasOrphan) return detail;
	if (isPlainObject(candidate) && candidate.found !== false && !isEmptyNotInScopeSourceShell(candidate, source)) {
		return overlayMergedEmploymentHistory(candidate, detail);
	}
	return null;
}

export function resolveOrderedSourcesFromDetail(detail: any, requestedSource: DashboardSource, declaredSources: DashboardSource[]): DashboardSource[] {
	const base = [requestedSource, ...declaredSources].filter((entry, index, arr) => (entry === 'finra' || entry === 'sec') && arr.indexOf(entry) === index);
	const finraPayload = unwrapSourceContent(detail?.sources?.finra, ['bccontent', 'content']) || detail?.finraNode || detail?.merged;
	const secPayload = unwrapSourceContent(detail?.sources?.sec, ['iacontent', 'content']) || detail?.finraNode || detail?.merged;
	const hasFinraData =
		detail?.hasFinraData === true || hasIndividualSourceCoverage(finraPayload, 'finra') || hasFirmSourceCoverage(finraPayload, 'finra');
	const hasSecData = detail?.hasSecData === true || hasIndividualSourceCoverage(secPayload, 'sec') || hasFirmSourceCoverage(secPayload, 'sec');

	if (!hasFinraData && hasSecData) return ['sec', 'finra'];
	if (hasFinraData && !hasSecData) return ['finra', 'sec'];
	return base.length > 0 ? base : ['finra', 'sec'];
}

export function resolveEmploymentStatusTag(
	row: any,
	firmInfo?: {
		isActive?: boolean;
		bcScope?: string;
		iaScope?: string;
		firmStatus?: string;
	},
): string {
	if (row?.statusTag && !/^inactive$/i.test(String(row.statusTag))) {
		return String(row.statusTag);
	}
	const rowBc = String(row?.firmBCScope || row?.bcScope || '').trim().toUpperCase();
	const rowIa = String(row?.firmIAScope || row?.iaScope || '').trim().toUpperCase();
	const rowFirmStatus = String(row?.firmStatus || '').trim().toLowerCase();

	if (rowBc === 'ACTIVE' || rowIa === 'ACTIVE' || rowFirmStatus === 'approved' || rowFirmStatus === 'active') {
		return 'Active';
	}

	if (firmInfo) {
		if (firmInfo.isActive) return 'Active';
		const infoBc = String(firmInfo.bcScope || '').trim().toUpperCase();
		const infoIa = String(firmInfo.iaScope || '').trim().toUpperCase();
		const infoStatus = String(firmInfo.firmStatus || '').trim().toLowerCase();
		if (infoBc === 'ACTIVE' || infoIa === 'ACTIVE' || infoStatus === 'approved' || infoStatus === 'active') {
			return 'Active';
		}
		if (infoBc === 'INACTIVE' || infoBc === 'TERMINATED' || infoIa === 'INACTIVE' || infoIa === 'TERMINATED') {
			return 'Inactive';
		}
	}

	if (rowBc === 'INACTIVE' || rowBc === 'TERMINATED' || rowIa === 'INACTIVE' || rowIa === 'TERMINATED') {
		return 'Inactive';
	}

	if (row?.status && String(row.status).trim()) {
		return String(row.status).trim();
	}

	return 'Active';
}
