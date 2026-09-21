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
	if (/^\d+$/.test(raw)) return `8-${raw}`;
	return raw;
}

export function buildParentFirmSummaryLinks(node: any, employmentEntries: any[] = []): ParentFirmSummaryLink[] {
	const entries =
		Array.isArray(employmentEntries) && employmentEntries.length ?
			employmentEntries
		: 	[...(Array.isArray(node?.currentEmployments) ? node.currentEmployments : []), ...(Array.isArray(node?.currentIAEmployments) ? node.currentIAEmployments : [])];
	const primaryEntry = entries.find((entry) => entry && String(entry?.firmId || entry?.firm_id || '').trim());
	const firmId = String(primaryEntry?.firmId || primaryEntry?.firm_id || '').trim();
	if (!firmId) return [];

	const scopeText = String(node?.bcScope || node?.basicInformation?.bcScope || node?.iaScope || node?.basicInformation?.iaScope || '').trim();
	const hasActiveScope = /active|approved/i.test(scopeText);
	const hasEmployment =
		Boolean(Array.isArray(node?.currentEmployments) && node.currentEmployments.length) || Boolean(Array.isArray(node?.currentIAEmployments) && node.currentIAEmployments.length);
	if (!hasActiveScope || !hasEmployment) return [];

	const secFirmId = normalizeSecFirmId(
		node?.iaSecNumber ||
		node?.iaSECNumber ||
		node?.bdSecNumber ||
		node?.bdSECNumber ||
		node?.basicInformation?.iaSecNumber ||
		node?.basicInformation?.iaSECNumber ||
		node?.basicInformation?.bdSecNumber ||
		node?.basicInformation?.bdSECNumber ||
		primaryEntry?.iaSecNumber ||
		primaryEntry?.iaSECNumber ||
		primaryEntry?.bdSecNumber ||
		primaryEntry?.bdSECNumber,
	);

	return [
		{
			label: 'Parent firm FINRA Summary',
			href: `https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}`,
			firmId,
			className: 'bc',
		},
		...(secFirmId ? [{
			label: 'Parent firm SEC AdvisorInfo Summary',
			href: `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}`,
			firmId,
			className: 'sec' as const,
		}] : []),
	];
}
