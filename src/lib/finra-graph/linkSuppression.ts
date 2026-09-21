// Shared suppression rules for external SEC/FINRA links.

const BROKEN_FINRA_FIRM_IDS = new Set(['134139', '298880', '314694', '325639']);
const SUPPRESSED_SEC_INDIV_IDS = new Set(['18040']);
const SUPPRESSED_SEC_FIRM_IDS = new Set(['2001', '4039', '25156', '36773']);

function normalizeExternalLinkLabel(value: unknown) {
	return String(value ?? '')
		.trim()
		.toLowerCase();
}

function hasSuppressedExternalLink(node: any, target: 'sec' | 'finra') {
	return Array.isArray(node?.suppressedExternalLinks) && node.suppressedExternalLinks.some((entry: unknown) => normalizeExternalLinkLabel(entry) === target);
}

function normalizeId(raw: unknown) {
	return String(raw ?? '')
		.replace(/^person[:_]/, '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
}

function hasAnyItems(value: unknown) {
	return Array.isArray(value) && value.some((entry) => entry != null && entry !== '');
}

function hasFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasFinraData === true) return true;
	if (node.hasFinraData === false) return false;
	if (Boolean(String(node?.bcScope || node?.basicInformation?.bcScope || '').trim())) return true;
	if (Boolean(String(node?.registrationCount?.approvedFinraRegistrationCount || node?.registrationCount?.approvedSRORegistrationCount || '').trim())) return true;
	if (hasAnyItems(node?.currentEmployments) || hasAnyItems(node?.previousEmployments)) return true;
	if (hasAnyItems(node?.currentIAEmployments) || hasAnyItems(node?.previousIAEmployments)) return true;
	return false;
}

function hasSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasSecData === true) return true;
	if (node.hasSecData === false) return false;
	if (Boolean(String(node?.iaScope || node?.basicInformation?.iaScope || '').trim())) return true;
	if (Boolean(String(node?.iaSecNumber || node?.basicInformation?.iaSecNumber || node?.secNumber || '').trim())) return true;
	if (Boolean(String(node?.secSummaryDescription || node?.basicInformation?.secSummaryDescription || '').trim())) return true;
	if (hasAnyItems(node?.secDocumentLinks)) return true;
	if (Boolean(String(node?.registrationCount?.approvedIAStateRegistrationCount || '').trim())) return true;
	if (hasAnyItems(node?.currentIAEmployments) || hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	return false;
}

export function shouldSuppressSecLink(node: any, kind?: 'individual' | 'firm') {
	if (!node || typeof node !== 'object') return false;
	if (hasSuppressedExternalLink(node, 'sec')) return true;

	if (kind === 'individual') {
		const rawId = normalizeId(node?.crd || node?.basicInformation?.individualId || node?.individualId || node?.id);
		if (rawId && SUPPRESSED_SEC_INDIV_IDS.has(rawId)) return true;
	}

	if (kind === 'firm') {
		const rawFirmId = normalizeId(node?.firmId || node?.id);
		if (rawFirmId && SUPPRESSED_SEC_FIRM_IDS.has(rawFirmId)) return true;
	}

	return false;
}

export function shouldSuppressFinraLink(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (hasSuppressedExternalLink(node, 'finra')) return true;

	const rawFirmId = normalizeId(node?.firmId || node?.id);
	return rawFirmId ? BROKEN_FINRA_FIRM_IDS.has(rawFirmId) : false;
}

export function buildDashboardProfileLinks(entity: 'individual' | 'firm', id: string, payload: any = {}) {
	const normalizedEntity = entity === 'firm' ? 'firm' : 'individual';
	const node = payload && typeof payload === 'object' ? payload : {};
	const links: Array<{ label: string; href: string }> = [];

	const finraAllowed = !shouldSuppressFinraLink(node) && hasFinraPresence(node);
	if (finraAllowed) {
		links.push({
			label: 'FINRA profile ↗',
			href: `https://brokercheck.finra.org/${normalizedEntity === 'firm' ? 'firm' : 'individual'}/summary/${encodeURIComponent(id)}`,
		});
		if (normalizedEntity === 'individual') {
			links.push({
				label: 'FINRA Detailed Report (PDF) ↗',
				href: `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(id)}.pdf`,
			});
		}
	}

	const secAllowed = !shouldSuppressSecLink(node, normalizedEntity) && hasSecPresence(node);
	if (secAllowed) {
		links.push({
			label: 'SEC profile ↗',
			href: `https://adviserinfo.sec.gov/${normalizedEntity === 'firm' ? 'firm' : 'individual'}/summary/${encodeURIComponent(id)}`,
		});
	}

	return links;
}

export { BROKEN_FINRA_FIRM_IDS, SUPPRESSED_SEC_FIRM_IDS, SUPPRESSED_SEC_INDIV_IDS };
