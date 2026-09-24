export type ParentFirmSummaryLink = {
	label: string;
	href: string;
	firmId?: string;
	className: 'bc' | 'sec';
};

function normalizeSecFirmId(value: string | number | null | undefined) {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	if (/^8-\d+$/i.test(raw)) return raw;
	// Only treat bare digits as IA SEC ids when the caller already confirmed IA scope.
	if (/^\d+$/.test(raw)) return `8-${raw}`;
	return raw;
}

function isNotInScope(value: unknown): boolean {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '') === 'notinscope'
	);
}

function isActiveScope(value: unknown): boolean {
	const text = String(value || '').trim();
	if (!text || isNotInScope(text)) return false;
	return /active|approved/i.test(text);
}

/** IA registration number only — never a BD `bdSECNumber`, which is not an AdvisorInfo firm id. */
function pickIaSecNumber(...candidates: Array<string | number | null | undefined>): string {
	for (const candidate of candidates) {
		const raw = String(candidate ?? '').trim();
		if (!raw) continue;
		if (/^8-\d+$/i.test(raw)) return normalizeSecFirmId(raw);
		// Bare digits are ambiguous (often BD numbers). Only accept when already prefixed 8-.
	}
	return '';
}

export function buildParentFirmSummaryLinks(node: any, employmentEntries: any[] = []): ParentFirmSummaryLink[] {
	const entries =
		Array.isArray(employmentEntries) && employmentEntries.length ?
			employmentEntries
		: 	[...(Array.isArray(node?.currentEmployments) ? node.currentEmployments : []), ...(Array.isArray(node?.currentIAEmployments) ? node.currentIAEmployments : [])];
	const primaryEntry = entries.find((entry) => entry && String(entry?.firmId || entry?.firm_id || '').trim());
	const firmId = String(primaryEntry?.firmId || primaryEntry?.firm_id || '').trim();
	if (!firmId) return [];

	const personBcScope = String(node?.bcScope || node?.basicInformation?.bcScope || '').trim();
	const personIaScope = String(node?.iaScope || node?.basicInformation?.iaScope || '').trim();
	const personHasActiveScope = isActiveScope(personBcScope) || isActiveScope(personIaScope);
	const hasEmployment =
		Boolean(Array.isArray(node?.currentEmployments) && node.currentEmployments.length) || Boolean(Array.isArray(node?.currentIAEmployments) && node.currentIAEmployments.length);
	if (!personHasActiveScope || !hasEmployment) return [];

	const firmBcScope = String(primaryEntry?.firmBCScope || primaryEntry?.firmBcScope || primaryEntry?.bcScope || '').trim();
	const firmIaScope = String(primaryEntry?.firmIAScope || primaryEntry?.firmIaScope || primaryEntry?.iaScope || '').trim();

	const iaSecNumber = pickIaSecNumber(
		node?.iaSecNumber,
		node?.iaSECNumber,
		node?.basicInformation?.iaSecNumber,
		node?.basicInformation?.iaSECNumber,
		primaryEntry?.iaSecNumber,
		primaryEntry?.iaSECNumber,
	);

	// AdvisorInfo firm pages exist for IA-registered firms. BD-only employers
	// (firmIAScope NotInScope + only bdSECNumber) must not get a SEC parent link —
	// those URLs fall through to the IAPD homepage.
	const firmHasIaPresence = Boolean(iaSecNumber) || isActiveScope(firmIaScope);
	const showFinraParent = !firmBcScope || isActiveScope(firmBcScope) || !isNotInScope(firmBcScope);

	const links: ParentFirmSummaryLink[] = [];
	if (showFinraParent) {
		links.push({
			label: 'Parent firm FINRA Summary',
			href: `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}`,
			firmId,
			className: 'bc',
		});
	}
	if (firmHasIaPresence) {
		const secHrefId = iaSecNumber || firmId;
		links.push({
			label: 'Parent firm SEC AdvisorInfo Summary',
			href: `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(secHrefId)}`,
			firmId,
			className: 'sec',
		});
	}
	return links;
}
