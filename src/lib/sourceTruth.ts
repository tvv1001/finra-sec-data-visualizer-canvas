import { normalizeIndividualDetailFromSource } from '@/lib/individualDetail';

type AnyRecord = Record<string, any>;
export type SourceDomain = 'finra' | 'sec';

export type IndividualSourceResolution = {
	detail: AnyRecord | null;
	hasEmbeddedDetail: boolean;
	hasFinraData: boolean;
	hasSecData: boolean;
	searchHitOnly: boolean;
};

function isPlainObject(value: unknown): value is AnyRecord {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeScopeValue(value: unknown) {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
}

export function isNotInScopeValue(value: unknown) {
	return normalizeScopeValue(value) === 'notinscope';
}

export function isInScopeValue(value: unknown) {
	const normalized = normalizeScopeValue(value);
	return Boolean(normalized) && normalized !== 'notinscope';
}

export function getEmbeddedContentObject(source: unknown, contentKeys: string[] = ['content', 'iacontent']): AnyRecord | null {
	if (!isPlainObject(source)) return null;
	for (const key of contentKeys) {
		const raw = source[key];
		if (raw == null) continue;
		if (isPlainObject(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (isPlainObject(parsed)) return parsed;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function buildIndividualRegistrationCount(source: AnyRecord) {
	return {
		approvedFinraRegistrationCount: Number(source.ind_approved_finra_registration_count ?? source.registrationCount?.approvedFinraRegistrationCount ?? 0) || 0,
		approvedSRORegistrationCount: Number(source.ind_approved_sro_registration_count ?? source.registrationCount?.approvedSRORegistrationCount ?? 0) || 0,
		approvedStateRegistrationCount: Number(source.ind_approved_state_registration_count ?? source.registrationCount?.approvedStateRegistrationCount ?? 0) || 0,
		approvedIAStateRegistrationCount: Number(source.ind_approved_ia_state_registration_count ?? source.registrationCount?.approvedIAStateRegistrationCount ?? 0) || 0,
	};
}

export function buildIndividualSearchHitStub(source: unknown, fallbackCrd = ''): AnyRecord | null {
	if (!isPlainObject(source)) return null;
	// Never treat a doc explicitly typed as a firm (e.g. minimal FINRA search-index stubs
	// like `{crd, label, type: 'firm'}`) as an individual — otherwise firm hits get
	// misclassified as individual nodes when only a bare `crd` field is present.
	if (String(source.type || '').toLowerCase() === 'firm') return null;
	const crd = String(source.ind_source_id || source.ind_crd || source.individualId || source.crd || fallbackCrd || '').trim();
	if (!crd) return null;
	const firstName = String(source.ind_firstname || source.firstName || '').trim();
	const middleName = String(source.ind_middlename || source.middleName || '').trim();
	const lastName = String(source.ind_lastname || source.lastName || '').trim();
	const otherNames =
		Array.isArray(source.ind_other_names) ? source.ind_other_names
		: Array.isArray(source.otherNames) ? source.otherNames
		: [];
	const bcScope = source.ind_bc_scope ?? source.bcScope ?? null;
	const iaScope = source.ind_ia_scope ?? source.iaScope ?? null;
	const disclosureFlag = source.ind_bc_disclosure_fl ?? source.disclosureFlag ?? null;
	const iaDisclosureFlag = source.ind_ia_disclosure_fl ?? source.iaDisclosureFlag ?? null;
	const registrationCount = buildIndividualRegistrationCount(source);
	const currentEmployments =
		Array.isArray(source.ind_current_employments) ? source.ind_current_employments
		: Array.isArray(source.currentEmployments) ? source.currentEmployments
		: [];
	const currentIAEmployments =
		Array.isArray(source.ind_ia_current_employments) ? source.ind_ia_current_employments
		: Array.isArray(source.currentIAEmployments) ? source.currentIAEmployments
		: [];
	const previousEmployments =
		Array.isArray(source.ind_previous_employments) ? source.ind_previous_employments
		: Array.isArray(source.previousEmployments) ? source.previousEmployments
		: [];
	const previousIAEmployments =
		Array.isArray(source.ind_ia_previous_employments) ? source.ind_ia_previous_employments
		: Array.isArray(source.previousIAEmployments) ? source.previousIAEmployments
		: [];
	const name = [firstName, middleName, lastName].filter(Boolean).join(' ').trim();

	return {
		individualId: crd,
		bcScope,
		iaScope,
		disclosureFlag,
		iaDisclosureFlag,
		registrationCount,
		currentEmployments,
		currentIAEmployments,
		previousEmployments,
		previousIAEmployments,
		basicInformation: {
			individualId: crd,
			firstName: firstName || undefined,
			middleName: middleName || undefined,
			lastName: lastName || undefined,
			name: name || undefined,
			otherNames,
			bcScope,
			iaScope,
		},
		_searchHitOnly: true,
	};
}

export function hasIndividualSourceCoverage(detail: unknown, source: SourceDomain) {
	if (!isPlainObject(detail)) return false;
	const basic = isPlainObject(detail.basicInformation) ? detail.basicInformation : {};
	const scope = source === 'finra' ? (detail.bcScope ?? basic.bcScope) : (detail.iaScope ?? basic.iaScope);
	if (isNotInScopeValue(scope)) return false;
	if (isInScopeValue(scope)) return true;

	const registrationCount = isPlainObject(detail.registrationCount) ? detail.registrationCount : {};
	if (source === 'finra') {
		if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) return true;
		if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) return true;
		if (Array.isArray(detail.currentEmployments) && detail.currentEmployments.length > 0) return true;
		if (Array.isArray(detail.previousEmployments) && detail.previousEmployments.length > 0) return true;
		if (Array.isArray(detail.registeredStates) && detail.registeredStates.some((s: any) => s?.regScope === 'BC')) return true;
		if (Array.isArray(detail.stateExamCategory) && detail.stateExamCategory.length > 0) return true;
		if (Array.isArray(detail.productExamCategory) && detail.productExamCategory.length > 0) return true;
		if (Array.isArray(detail.principalExamCategory) && detail.principalExamCategory.length > 0) return true;
		return false;
	}

	if (Number(registrationCount.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (Array.isArray(detail.currentIAEmployments) && detail.currentIAEmployments.length > 0) return true;
	if (Array.isArray(detail.previousIAEmployments) && detail.previousIAEmployments.length > 0) return true;
	if (Array.isArray(detail.iaDisclosures) && detail.iaDisclosures.length > 0) return true;
	if (Array.isArray(detail.registeredStates) && detail.registeredStates.some((s: any) => s?.regScope === 'IA')) return true;
	return false;
}

export function hasFirmSourceCoverage(detail: unknown, source: SourceDomain): boolean {
	if (!isPlainObject(detail)) return false;
	const basic = isPlainObject(detail.basicInformation) ? detail.basicInformation : {};
	const scope = source === 'finra' ? (detail.bcScope ?? basic.bcScope) : (detail.iaScope ?? basic.iaScope);
	if (isNotInScopeValue(scope)) return false;
	if (isInScopeValue(scope)) return true;

	if (source === 'finra') {
		if (
			String(detail.isLegacy || basic.isLegacy || '')
				.trim()
				.toUpperCase() === 'Y'
		)
			return true;
		if (Array.isArray(detail.selfRegulatoryOrgs) && detail.selfRegulatoryOrgs.length > 0) return true;
		if (Boolean(String(detail.districtName || basic.districtName || '').trim())) return true;
		if (Boolean(String(detail.bdSECNumber || detail.bdSecNumber || basic.bdSECNumber || basic.bdSecNumber || '').trim())) return true;
		return false;
	}

	const orgFlags = isPlainObject(detail.orgScopeStatusFlags) ? detail.orgScopeStatusFlags : (isPlainObject(basic.orgScopeStatusFlags) ? basic.orgScopeStatusFlags : {});
	const secRegistrationFlag = String(orgFlags.isSECRegistered ?? orgFlags.isSecRegistered ?? '').trim().toLowerCase();
	if (['n', 'no', 'false', '0'].includes(secRegistrationFlag)) {
		return false;
	}
	if (Boolean(String(detail.iaSECNumber || detail.iaSecNumber || basic.iaSECNumber || basic.iaSecNumber || '').trim())) return true;
	if (Boolean(String(detail.secNumber || detail.sec_number || basic.secNumber || basic.sec_number || '').trim())) return true;
	if (Array.isArray(detail.noticeFilings) && detail.noticeFilings.length > 0) return true;
	if (Array.isArray(basic.noticeFilings) && basic.noticeFilings.length > 0) return true;
	if (Array.isArray(detail.brochures) && detail.brochures.length > 0) return true;
	if (Array.isArray(basic.brochures) && basic.brochures.length > 0) return true;
	if (isPlainObject(detail.crs) || isPlainObject(basic.crs)) return true;
	if (Array.isArray(detail.secDocumentLinks) && detail.secDocumentLinks.some((link: any) => typeof link?.href === 'string' && /adviserinfo\.sec\.gov\//.test(link.href))) return true;
	return false;
}

export function resolveIndividualSourceDetail(source: unknown, fallbackCrd = ''): IndividualSourceResolution {
	if (!isPlainObject(source)) {
		return { detail: null, hasEmbeddedDetail: false, hasFinraData: false, hasSecData: false, searchHitOnly: false };
	}

	if (isPlainObject(source.basicInformation)) {
		return {
			detail: source as AnyRecord,
			hasEmbeddedDetail: true,
			hasFinraData: source.hasFinraData ?? hasIndividualSourceCoverage(source, 'finra'),
			hasSecData: source.hasSecData ?? hasIndividualSourceCoverage(source, 'sec'),
			searchHitOnly: false,
		};
	}

	const embedded = getEmbeddedContentObject(source, ['content', 'iacontent']);
	if (embedded) {
		const detail = normalizeIndividualDetailFromSource(embedded, fallbackCrd) as AnyRecord;
		return {
			detail,
			hasEmbeddedDetail: true,
			hasFinraData: hasIndividualSourceCoverage(detail, 'finra'),
			hasSecData: hasIndividualSourceCoverage(detail, 'sec'),
			searchHitOnly: false,
		};
	}

	const detail = buildIndividualSearchHitStub(source, fallbackCrd);
	return {
		detail,
		hasEmbeddedDetail: false,
		hasFinraData: hasIndividualSourceCoverage(detail, 'finra'),
		hasSecData: hasIndividualSourceCoverage(detail, 'sec'),
		searchHitOnly: detail?._searchHitOnly === true,
	};
}
