type AnyRecord = Record<string, any>;

function isPlainObject(value: unknown): value is AnyRecord {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toArray<T = any>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value == null || value === '') return [];
	return [value as T];
}

function mergeUniqueArrays(...arrays: unknown[][]) {
	const out: any[] = [];
	const seen = new Set<string>();
	for (const array of arrays) {
		for (const item of Array.isArray(array) ? array : []) {
			const key = JSON.stringify(item);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

function buildBasicInformation(detail: AnyRecord, fallbackCrd = '') {
	const bi: AnyRecord = isPlainObject(detail.basicInformation) ? { ...detail.basicInformation } : {};
	// Never fabricate an individualId from `crd` for docs explicitly typed as a firm (e.g. minimal
	// search-index stubs like `{crd, label, type: 'firm'}`) — doing so previously caused firm search
	// hits to be misclassified and rendered as individual nodes.
	const isFirmTyped = String(detail.type || '').toLowerCase() === 'firm';
	const id = detail.individualId || detail.ind_source_id || (isFirmTyped ? '' : detail.crd) || fallbackCrd;
	if (id && !bi.individualId) bi.individualId = id;
	if (!bi.firstName && detail.firstName) bi.firstName = detail.firstName;
	if (!bi.middleName && detail.middleName) bi.middleName = detail.middleName;
	if (!bi.lastName && detail.lastName) bi.lastName = detail.lastName;
	if (!bi.name && detail.name) bi.name = detail.name;
	if (!bi.bcScope && detail.bcScope) bi.bcScope = detail.bcScope;
	if (!bi.iaScope && detail.iaScope) bi.iaScope = detail.iaScope;
	if (!bi.otherNames && detail.otherNames) bi.otherNames = detail.otherNames;
	return Object.keys(bi).length ? bi : null;
}

function buildRegistrationCount(detail: AnyRecord) {
	const existing = isPlainObject(detail.registrationCount) ? detail.registrationCount : {};
	const count = {
		approvedFinraRegistrationCount: detail.ind_approved_finra_registration_count ?? existing.approvedFinraRegistrationCount ?? 0,
		approvedSRORegistrationCount: detail.ind_approved_sro_registration_count ?? existing.approvedSRORegistrationCount ?? 0,
		approvedStateRegistrationCount: detail.ind_approved_state_registration_count ?? existing.approvedStateRegistrationCount ?? 0,
		approvedIAStateRegistrationCount: detail.ind_approved_ia_state_registration_count ?? existing.approvedIAStateRegistrationCount ?? 0,
	};
	return count;
}

export function normalizeIndividualDetailPayload(detail: unknown, fallbackCrd = '') {
	if (!isPlainObject(detail)) return detail;
	const normalized: AnyRecord = { ...detail };

	const currentEmployments = mergeUniqueArrays(toArray(normalized.currentEmployments), toArray(normalized.ind_current_employments));
	const previousEmployments = mergeUniqueArrays(toArray(normalized.previousEmployments), toArray(normalized.ind_previous_employments));
	const currentIAEmployments = mergeUniqueArrays(toArray(normalized.currentIAEmployments), toArray(normalized.ind_ia_current_employments));
	const previousIAEmployments = mergeUniqueArrays(toArray(normalized.previousIAEmployments), toArray(normalized.ind_ia_previous_employments));
	const registeredStates = mergeUniqueArrays(toArray(normalized.registeredStates), toArray(normalized.ind_registered_states));
	const registeredSROs = mergeUniqueArrays(toArray(normalized.registeredSROs), toArray(normalized.ind_registered_sros));

	if (currentEmployments.length) normalized.currentEmployments = currentEmployments;
	if (previousEmployments.length) normalized.previousEmployments = previousEmployments;
	if (currentIAEmployments.length) normalized.currentIAEmployments = currentIAEmployments;
	if (previousIAEmployments.length) normalized.previousIAEmployments = previousIAEmployments;
	if (registeredStates.length) normalized.registeredStates = registeredStates;
	if (registeredSROs.length) normalized.registeredSROs = registeredSROs;

	const bi = buildBasicInformation(normalized, fallbackCrd);
	if (bi && !normalized.basicInformation) normalized.basicInformation = bi;

	const registrationCount = buildRegistrationCount(normalized);
	if (registrationCount) normalized.registrationCount = registrationCount;

	if (!normalized.examsCount && normalized.ind_exams_count != null) normalized.examsCount = normalized.ind_exams_count;
	if (!normalized.brokerDetails && normalized.ind_broker_details) normalized.brokerDetails = normalized.ind_broker_details;

	return normalized;
}

export function normalizeIndividualDetailFromSource(source: unknown, fallbackCrd = '') {
	if (!isPlainObject(source)) return source;
	const merged: AnyRecord = { ...source };
	if (typeof merged.content === 'string') {
		try {
			const parsed = JSON.parse(merged.content);
			if (isPlainObject(parsed)) {
				Object.assign(merged, parsed);
			}
		} catch {
			// ignore malformed embedded JSON
		}
	}
	return normalizeIndividualDetailPayload(merged, fallbackCrd);
}
