import { formatEntityName, formatPersonName, formatFirmName, buildPersonName } from './nameFormat';

type RecordEntity = 'individual' | 'firm';

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function getRecordObject(value: unknown): Record<string, any> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, any>;
}

function tryParseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

function unwrapRecordPayload(value: unknown): unknown {
	const parsed = tryParseJson(value);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
	const payload = parsed as Record<string, any>;
	if (payload.finraBrokerCheck && typeof payload.finraBrokerCheck === 'object') return unwrapRecordPayload(payload.finraBrokerCheck);
	if (payload.secInvestmentAdvisor && typeof payload.secInvestmentAdvisor === 'object') return unwrapRecordPayload(payload.secInvestmentAdvisor);
	if (payload.content != null) return unwrapRecordPayload(payload.content);
	if (payload.iacontent != null) return unwrapRecordPayload(payload.iacontent);
	const firstHit = Array.isArray(payload.hits?.hits) ? payload.hits.hits[0] : null;
	if (firstHit && typeof firstHit === 'object') {
		const source = firstHit._source;
		if (source && typeof source === 'object') {
			if (source.content != null) return unwrapRecordPayload(source.content);
			if (source.iacontent != null) return unwrapRecordPayload(source.iacontent);
			return unwrapRecordPayload(source);
		}
	}
	if (payload._source && typeof payload._source === 'object') return unwrapRecordPayload(payload._source);
	return payload;
}

function collectNameCandidates(payload: unknown, entity: RecordEntity): string[] {
	const data = unwrapRecordPayload(payload);
	const record = getRecordObject(data);
	if (!record) return [];

	const basic = getRecordObject(record.basicInformation) || getRecordObject(record.bc) || getRecordObject(record.ia) || {};
	const candidates: string[] = [];

	if (entity === 'individual') {
		const orphanName = toText(record.orphan?.name);
		const firstName = toText(
			record.firstName ||
				record.first_name ||
				basic.firstName ||
				basic.first_name ||
				record.basicInformation?.firstName ||
				record.basicInformation?.first_name ||
				record.ia?.firstName ||
				record.ia?.first_name ||
				record.bc?.firstName ||
				record.bc?.first_name,
		);
		const middleName = toText(
			record.middleName ||
				record.middle_name ||
				record.mid_name ||
				basic.middleName ||
				basic.middle_name ||
				basic.mid_name ||
				record.basicInformation?.middleName ||
				record.basicInformation?.middle_name ||
				record.ia?.middleName ||
				record.ia?.middle_name ||
				record.bc?.middleName ||
				record.bc?.middle_name,
		);
		const lastName = toText(
			record.lastName ||
				record.last_name ||
				basic.lastName ||
				basic.last_name ||
				record.basicInformation?.lastName ||
				record.basicInformation?.last_name ||
				record.ia?.lastName ||
				record.ia?.last_name ||
				record.bc?.lastName ||
				record.bc?.last_name,
		);
		const combined = buildPersonName(firstName, middleName, lastName);
		const altNames = [
			combined,
			orphanName,
			record.name,
			record.fullName,
			record.individualName,
			basic.name,
			basic.fullName,
			basic.individualName,
			record.basicInformation?.name,
			record.basicInformation?.fullName,
			record.basicInformation?.individualName,
		];
		candidates.push(...altNames.map((value) => toText(value)));
		return candidates.filter(Boolean).map((name) => formatPersonName(name));
	}

	const orphanFirmName = toText(record.orphan?.firmName || record.orphan?.name);
	const altNames = [
		record.legalName,
		record.firmName,
		record.name,
		record.fullName,
		orphanFirmName,
		record.organizationName,
		record.doingBusinessAs,
		basic.legalName,
		basic.firmName,
		basic.name,
		basic.fullName,
		basic.organizationName,
		basic.doingBusinessAs,
		record.basicInformation?.legalName,
		record.basicInformation?.firmName,
		record.basicInformation?.name,
		record.basicInformation?.fullName,
		record.basicInformation?.organizationName,
		record.basicInformation?.doingBusinessAs,
	];
	candidates.push(...altNames.map((value) => toText(value)));
	return candidates.filter(Boolean).map((name) => formatFirmName(name));
}

export function getRecordDisplayName(payload: unknown, entity: RecordEntity, id: string): string {
	const fallback = entity === 'firm' ? `Firm ${id}` : `Individual ${id}`;
	for (const candidate of collectNameCandidates(payload, entity)) {
		if (candidate) return candidate;
	}
	return fallback;
}
