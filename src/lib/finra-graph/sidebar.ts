import { capitalize, esc, firmSizeLabel, formatLocationText, formatUiText, normalizePersonLabel, formatFirmName, formatPersonName, formatEntityName, row } from './formatters';
import { buildParentFirmSummaryLinks } from './externalLinks';

type RenderContext = {
	graphData?: any;
};

function hasAnyItems(list: any[] | null | undefined) {
	return Array.isArray(list) && list.length > 0;
}

function hasPublicFinraIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const bcScope = String(detail?.bcScope || basicInformation?.bcScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (bcScope === 'notinscope') return false;
	if (bcScope && bcScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) return true;
	if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.registeredSROs)) return true;

	return false;
}

function hasPublicSecIndividualPage(detail: any, basicInformation: Record<string, any> = {}) {
	const iaScope = String(detail?.iaScope || basicInformation?.iaScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (iaScope && iaScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(detail?.currentIAEmployments)) return true;
	if (hasAnyItems(detail?.previousIAEmployments)) return true;
	if (hasAnyItems(detail?.iaDisclosures)) return true;
	if (
		Array.isArray(detail?.registeredStates) &&
		detail.registeredStates.some(
			(entry: any) =>
				String(entry?.regScope || '')
					.trim()
					.toLowerCase() === 'ia',
		)
	) {
		return true;
	}

	return false;
}

type NodeSourceCoverage = 'both' | 'sec_only' | 'finra_only' | 'none';

function toNodeSourceCoverage(finra: boolean, sec: boolean): NodeSourceCoverage {
	if (finra && sec) return 'both';
	if (sec) return 'sec_only';
	if (finra) return 'finra_only';
	return 'none';
}

// Firms known to have broken or unreachable FINRA/BrokerCheck summary pages.
// Add CRD numbers here to suppress FINRA links for those firms.
const BROKEN_FINRA_FIRM_IDS = new Set(['134139', '298880', '314694', '325639']);

// Individual IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric individual CRD-like ids (no prefix) here when upstream SEC pages are incorrect or undesirable.
const SUPPRESSED_SEC_INDIV_IDS = new Set(['18040']);
// Firm IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric firm CRD-like ids (no prefix) here when upstream SEC pages are unavailable or incorrect.
const SUPPRESSED_SEC_FIRM_IDS = new Set(['4039', '25156', '36773']);

function isNotInScopeValue(value) {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '') === 'notinscope'
	);
}

function hasIndividualFinraPresence(node) {
	if (!node || typeof node !== 'object') return false;
	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (hasPublicFinraIndividualPage(node, node.basicInformation || {})) return true;
	if (hasAnyItems(node?.currentEmployments)) return true;
	if (hasAnyItems(node?.previousEmployments)) return true;
	return false;
}

function hasIndividualSecPresence(node) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses SEC links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;

	// Per-id suppression: if the node's id/crd is known to be invalid for SEC links, suppress.
	const rawId = String(node?.crd || node?.basicInformation?.individualId || node?.individualId || node?.id || '')
		.replace(/^person[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawId && SUPPRESSED_SEC_INDIV_IDS.has(rawId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (hasPublicSecIndividualPage(node, node.basicInformation || {})) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (
		Array.isArray(node?.registeredStates) &&
		node.registeredStates.some((entry) => {
			if (!entry || typeof entry !== 'object') return false;
			const scope = String(entry.regScope || entry.scope || '')
				.trim()
				.toLowerCase();
			return scope === 'ia';
		})
	) {
		return true;
	}
	if (hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	return false;
}

function hasFirmFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;

	// if this firm is explicitly blacklisted, treat as no FINRA presence
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && BROKEN_FINRA_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (node.isLegacy === 'Y') return true;
	// If this firm carries a SEC '8-' identifier and we don't have explicit FINRA data,
	// treat it as SEC-only and do not surface a FINRA brokercheck link.
	const secIdRaw = node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.bdSECNumber || node?.bdSECNumber || '';
	const secId = String(secIdRaw || '').trim();
	if (secId && /^8-\d+/i.test(secId)) return false;

	if (Boolean(String(node?.bcScope || node?.basicInformation?.bcScope || '').trim())) return true;
	return false;
}

function hasFirmSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && SUPPRESSED_SEC_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (Boolean(String(node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.iaSecNumber || '').trim())) return true;
	if (hasAnyItems(node?.secDocumentLinks)) return true;
	if (Boolean(String(node?.secSummaryDescription || '').trim())) return true;
	return false;
}

function formatNodeSourceTruthSummary(node: any) {
	const finra = node?.group === 'firm' ? hasFirmFinraPresence(node) : hasIndividualFinraPresence(node);
	const sec = node?.group === 'firm' ? hasFirmSecPresence(node) : hasIndividualSecPresence(node);
	const coverage = toNodeSourceCoverage(finra, sec);
	const coverageLabel =
		coverage === 'both' ? 'both SEC+FINRA'
		: coverage === 'sec_only' ? 'SEC only'
		: coverage === 'finra_only' ? 'FINRA only'
		: 'none';
	return `FINRA=${finra ? 'true' : 'false'} · SEC=${sec ? 'true' : 'false'} (${coverageLabel})`;
}

function buildDashboardDetailsHref(node: any) {
	const group = String(node?.group || '')
		.trim()
		.toLowerCase();
	if (group === 'firm') {
		const firmId = String(node?.firmId || node?.basicInformation?.firmId || node?.id || '')
			.replace(/^firm[:_]/, '')
			.replace(/^node[:_]/, '')
			.trim();
		return firmId ? `/dashboard/firm/${encodeURIComponent(firmId)}` : null;
	}
	const individualId = String(node?.crd || node?.individualId || node?.basicInformation?.individualId || node?.basicInformation?.crd || node?.id || '')
		.replace(/^person[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	return individualId ? `/dashboard/individual/${encodeURIComponent(individualId)}` : null;
}

export function renderPersonDetail(d: any, context: RenderContext = {}) {
	const graphData = context.graphData;
	const bi = d.basicInformation || {};
	const hasFinraPage = hasIndividualFinraPresence(d);
	const hasSecPage = hasIndividualSecPresence(d);
	const links: any[] = (graphData?.links || []).filter((l: any) => (l.source?.id || l.source) === d.id || (l.target?.id || l.target) === d.id);
	const controlLinks = links.filter((l: any) => l.relationship === 'controls');

	const stubBadge = d.stub ? `<span class='fg-badge stub'>Form BD stub</span>` : '';

	if (d.orphan && typeof d.orphan === 'object') {
		const orphan = d.orphan;
		const parentCrd = orphan.parentCrd ? String(orphan.parentCrd).trim() : String(d.orphanParentCrd || '').trim();
		const parentType = String(orphan.parentType || d.orphanParentType || 'firm')
			.trim()
			.toLowerCase();
		const firmName = formatFirmName(orphan.firmName || d.orphanFirmName || '');
		const position = formatUiText(orphan.position || d.orphanPosition || '');
		const firmStatusRaw = String(orphan.firmStatus || orphan.status || d.firmStatus || '').trim();
		const firmIsInactive = /inactive|terminated|revoked|suspended|notinscope/i.test(firmStatusRaw.replace(/\s+/g, ''));
		const employmentStatusLabel = firmIsInactive ? 'Inactive' : position || 'Currently Employed';
		const officeObj = orphan.officeAddress && typeof orphan.officeAddress === 'object' ? (orphan.officeAddress as Record<string, any>) : null;
		const mailingObj = orphan.mailingAddress && typeof orphan.mailingAddress === 'object' ? (orphan.mailingAddress as Record<string, any>) : null;
		const officeAddress = formatLocationText(
			officeObj
				? [officeObj.street1 || officeObj.street, officeObj.street2, officeObj.city, officeObj.state, officeObj.postalCode || officeObj.zipCode || officeObj.zip, officeObj.country]
						.filter(Boolean)
						.join(', ')
				: typeof orphan.officeAddress === 'string'
					? orphan.officeAddress
					: '',
		);
		const mailingAddress = formatLocationText(
			mailingObj
				? [
						mailingObj.street1 || mailingObj.street,
						mailingObj.street2,
						mailingObj.city,
						mailingObj.state,
						mailingObj.postalCode || mailingObj.zipCode || mailingObj.zip,
						mailingObj.country,
					]
						.filter(Boolean)
						.join(', ')
				: typeof orphan.mailingAddress === 'string'
					? orphan.mailingAddress
					: '',
		);
		const parentFirmUrl = parentCrd ? `https://brokercheck.finra.org/${parentType === 'individual' ? 'individual' : 'firm'}/summary/${encodeURIComponent(parentCrd)}` : null;
		const parentSecUrl = parentCrd && parentType !== 'individual' ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(parentCrd)}` : null;
		const dashboardHref = buildDashboardDetailsHref(d);
		const parentFirmButton =
			parentCrd ?
				`<button class='fg-crd-link' data-crd='${esc(parentCrd)}' data-crd-type='${parentType === 'individual' ? 'individual' : 'firm'}' title='View this CRD'>${esc(firmName || `Firm ${parentCrd}`)}</button>`
			:	esc(firmName || '');
		const employmentSectionTitle = firmIsInactive ? 'Previous Employment (1)' : 'Current Employment (1)';
		const employmentCard =
			parentCrd && (firmName || parentCrd) ?
				`<div class='fg-section-title fg-section-title--sticky'>${employmentSectionTitle}</div>
            <div class='fg-timeline${firmIsInactive ? ' fg-timeline--previous' : ''}'>
              <div class='fg-tl-entry${firmIsInactive ? '' : ' active-pos'}'>
                <span class='fg-tl-firm'>${parentFirmButton} <small>CRD#${esc(parentCrd)}</small></span>
                <span class='fg-tl-dates'> – → present </span>
                ${officeAddress ? `<span class='fg-tl-loc'>${esc(officeAddress)}</span>` : ''}
                <span class='fg-tl-loc' style='color:var(--text-m)'>${esc([employmentStatusLabel, firmIsInactive ? 'Inactive' : 'Active FINRA'].filter(Boolean).join(' · '))}</span>
              </div>
            </div>`
			:	'';

		return `
    <div class='fg-sb-header individual'>
      <div class='fg-sb-title'>${esc(normalizePersonLabel(d.label || orphan.name || ''))}</div>
      <div class='fg-sb-badges'>
        <span class='fg-badge ${firmIsInactive ? 'inactive' : 'active'}' title='Parent firm registration status'>${firmIsInactive ? 'Inactive' : 'Active'} finra</span>
        <span class='fg-badge stub' title='Form BD Direct Owners &amp; Executive Officers reference'>Form BD — Direct Owners &amp; Executive Officers</span>
      </div>
    </div>
    <div class='fg-sb-body fg-sb-body--person'>
      ${officeAddress ? row('Main Address', esc(officeAddress), 'fg-detail-row--stacked') : ''}
      ${mailingAddress && mailingAddress !== officeAddress ? row('Mailing', esc(mailingAddress), 'fg-detail-row--stacked') : ''}
      ${orphan.phone ? row('Phone', esc(String(orphan.phone))) : ''}
      <div class='fg-ext-links'>
        ${
					// No live individual detail page — link FINRA/SEC to the parent firm instead.
					parentFirmUrl ? `<a class='fg-ext-link bc' href='${parentFirmUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA profile</a>` : ''
				}
        ${parentSecUrl ? `<a class='fg-ext-link sec' href='${parentSecUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; SEC profile</a>` : ''}
        ${dashboardHref ? `<a class='fg-ext-link dashboard' href='${esc(dashboardHref)}' onclick='event.stopPropagation()'>Dashboard details</a>` : ''}
      </div>
      ${position ? row('Position', esc(position)) : ''}
      ${parentCrd ? row('CRD', `<code>${esc(String(orphan.crd || d.crd || ''))}</code>`) : ''}
      ${employmentCard}
    </div>`;
	}

	function formatDomainScopeBadge(text: string | null | undefined, domain: string, sourceTitle: string) {
		const raw = String(text || '').trim();
		if (!raw) return '';
		const normalized = raw.toLowerCase().replace(/\s+/g, '');
		const isActive = /active|approved/.test(normalized) && !/inactive|notinscope|terminated|revoked|suspended/.test(normalized);
		const label = `${isActive ? 'Active' : 'Inactive'} ${domain}`;
		return `<span class='fg-badge ${isActive ? 'active' : 'inactive'}' title='${esc(sourceTitle)}'>${esc(label)}</span>`;
	}

	const finraScopeText = d.bcScope || bi.bcScope || (hasFinraPage ? 'Active' : '');
	const secScopeText = d.iaScope || bi.iaScope || (hasSecPage ? 'Active' : '');
	const scopeBadgesHtml = [formatDomainScopeBadge(finraScopeText, 'finra', 'FINRA'), formatDomainScopeBadge(secScopeText, 'sec', 'SEC AdvisorInfo')].filter(Boolean).join(' ');

	const dashboardHref = buildDashboardDetailsHref(d);
	const rawDisclosures = [
		...(d.disclosures || []).map((dis) => ({ ...dis, _sourceLabel: dis?._sourceLabel || 'FINRA' })),
		...(d.iaDisclosures || []).map((dis) => ({ ...dis, _sourceLabel: dis?._sourceLabel || 'SEC AdvisorInfo' })),
	];
	const allDisclosures = (() => {
		function normalizeTypeForKey(val: any) {
			return String(val || '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, ' ')
				.trim();
		}

		function disHasContent(dis: any) {
			return !!(
				(dis.eventDate || dis.date || '').trim() ||
				(dis.disclosureResolution || dis.resolution || '').trim() ||
				(dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0)
			);
		}

		const byType = new Map();
		for (const dis of rawDisclosures) {
			const dtype = normalizeTypeForKey(dis.disclosureType || dis.type || '');
			if (!byType.has(dtype)) byType.set(dtype, false);
			if (disHasContent(dis)) byType.set(dtype, true);
		}

		const seen = new Map();
		for (const dis of rawDisclosures) {
			const dtype = normalizeTypeForKey(dis.disclosureType || dis.type || '');
			const ddate = normalizeDateForKey(dis.eventDate || dis.date || '');
			const key = `${dtype}||${ddate}`;
			const hasContent = disHasContent(dis);

			if (!hasContent && byType.get(dtype)) continue;

			if (!seen.has(key)) {
				seen.set(key, { ...dis });
			} else {
				const existing = seen.get(key);
				if (existing._sourceLabel && dis._sourceLabel && existing._sourceLabel !== dis._sourceLabel) {
					const sources = new Set([...existing._sourceLabel.split(',').map((s: string) => s.trim()), ...dis._sourceLabel.split(',').map((s: string) => s.trim())]);
					existing._sourceLabel = Array.from(sources).join(', ');
				}
				if (hasContent && !disHasContent(existing)) {
					const mergedLabel = existing._sourceLabel;
					const updated = { ...dis };
					updated._sourceLabel = mergedLabel;
					seen.set(key, updated);
				}
			}
		}
		return Array.from(seen.values()).sort((a, b) => compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['eventDate', 'date'] }));
	})();
	const disclosureCount = allDisclosures.length;
	const aliases = (d.otherNames?.length ? d.otherNames : bi.otherNames || []).map((alias) => normalizePersonLabel(alias)).filter(Boolean);

	function empToEntry(emp, isCurrent) {
		const bo = emp.branchOfficeLocations?.[0];
		const city = emp.city || bo?.city || '';
		const state = emp.state || bo?.state || '';
		const street1 = bo?.street1 || '';
		const street2 = bo?.street2 || '';
		const zip = emp.zipCode || bo?.zipCode || '';
		const loc = formatLocationText([city, state].filter(Boolean).join(', '));
		const addr = formatLocationText([street1, street2, city, state, zip].filter(Boolean).join(', '));
		return {
			firmName: emp.firmName || '',
			firmId: emp.firmId,
			bdSecNumber: emp.bdSECNumber,
			iaSECNumber: emp.iaSECNumber,
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent: isCurrent || !emp.registrationEndDate,
			employmentStatus: emp.employmentStatus || emp.status || emp.currentStatus || '',
			iaOnly: emp.iaOnly === 'Y',
			firmBCScope: emp.firmBCScope,
			firmIAScope: emp.firmIAScope,
			loc,
			addr,
			expelledDate: emp.expelledDate,
		};
	}

	function getEmploymentDetailLine(entry) {
		return entry.addr || entry.loc || '';
	}

	function getEmploymentScopeTags(entry) {
		return [
			entry.employmentStatus ? formatUiText(entry.employmentStatus) : null,
			entry.iaOnly ? 'IA only' : null,
			entry.firmBCScope && entry.firmBCScope !== 'ACTIVE' ? `Firm FINRA: ${formatUiText(entry.firmBCScope)}` : null,
		].filter(Boolean);
	}

	function regToEntry(emp, role, isCurrent) {
		const office = emp.branchOfficeLocations?.[0];
		const officeAddress = office ? formatLocationText([office.street1, office.street2, office.city, office.state, office.zipCode].filter(Boolean).join(', ')) : '';
		const cityState = formatLocationText([emp.city || office?.city || '', emp.state || office?.state || ''].filter(Boolean).join(', '));
		return {
			role,
			firmId: emp.firmId,
			firmName: emp.firmName || '',
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent,
			officeAddress,
			cityState,
		};
	}

	function normalizeDateForKey(val: any) {
		const parsed = parseSortDateValue(val);
		return parsed !== Number.NEGATIVE_INFINITY ? new Date(parsed).toISOString().split('T')[0] : String(val).trim().toLowerCase();
	}

	function dedupeRegs(items) {
		const seen = new Set();
		return items.filter((item) => {
			const normStart = item.start ? normalizeDateForKey(item.start) : '';
			const normEnd = item.end ? normalizeDateForKey(item.end) : 'present';
			const key = [
				item.role,
				String(item.firmId || '').trim(),
				normStart,
				normEnd,
				String(item.cityState || '')
					.trim()
					.toLowerCase(),
			].join('|');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function parseSortDateValue(value) {
		const raw = String(value || '').trim();
		if (!raw) return Number.NEGATIVE_INFINITY;
		const shortDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (shortDateMatch) {
			const [, month, day, year] = shortDateMatch;
			return Date.UTC(Number(year), Number(month) - 1, Number(day));
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}

	function compareCurrentFirstByDates(a, b, options: { currentKey?: string; dateKeys?: string[] } = {}) {
		const currentKey = options.currentKey || 'isCurrent';
		const dateKeys = Array.isArray(options.dateKeys) ? options.dateKeys : [];
		const aCurrent = Boolean(a?.[currentKey]);
		const bCurrent = Boolean(b?.[currentKey]);
		if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

		for (const key of dateKeys) {
			const diff = parseSortDateValue(b?.[key]) - parseSortDateValue(a?.[key]);
			if (diff !== 0) return diff;
		}

		return String(a?.firmName || a?.label || a?.brochureName || a?.examName || a?.type || '').localeCompare(
			String(b?.firmName || b?.label || b?.brochureName || b?.examName || b?.type || ''),
		);
	}

	function renderRegistrationRole(roleOrRoles, { inactive = false }: { inactive?: boolean } = {}) {
		// Accept a single role string (e.g., 'B' or 'IA') or an array / Set of roles
		let roles: string[] = [];
		if (Array.isArray(roleOrRoles)) roles = roleOrRoles.map((r) => String(r || '').trim());
		else if (roleOrRoles instanceof Set) roles = Array.from(roleOrRoles).map((r) => String(r || '').trim());
		else if (roleOrRoles == null) roles = [];
		else roles = [String(roleOrRoles || '').trim()];

		const badges = roles
			.filter(Boolean)
			.map((r) => {
				const normalizedRole = String(r || '')
					.trim()
					.toUpperCase();
				const label =
					normalizedRole === 'B' ? 'Broker'
					: normalizedRole === 'IA' ? 'Investment Adviser'
					: r || 'Registration';
				const roleClass =
					normalizedRole === 'B' ? 'fg-reg-role--broker'
					: normalizedRole === 'IA' ? 'fg-reg-role--ia'
					: 'fg-reg-role--default';
				return `<span class='fg-reg-role ${roleClass}${inactive ? ' is-inactive' : ''}' title='${esc(label)}'><span class='fg-reg-role__icon'>${esc(normalizedRole || label.charAt(0))}</span><span class='fg-reg-role__label'>${esc(label)}</span></span>`;
			})
			.join(' ');
		if (!badges)
			return `<span class='fg-reg-role fg-reg-role--default${inactive ? ' is-inactive' : ''}' title='Registration'><span class='fg-reg-role__icon'>R</span><span class='fg-reg-role__label'>Registration</span></span>`;
		return badges;
	}

	function mergeRegistrations(items) {
		const groups = new Map();
		for (const it of items) {
			const key = String(it.firmId || normalizeFirmKey(it.firmName) || '').trim();
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(it);
		}
		const merged = [];
		for (const [key, list] of groups.entries()) {
			if (!list || !list.length) continue;
			if (list.length === 1) {
				merged.push(list[0]);
				continue;
			}
			const roles = new Set();
			let earliest = null;
			let chosen = { ...list[0] };
			for (const l of list) {
				if (l.role) roles.add(String(l.role || '').trim());
				if (l.start) {
					const parsed = parseSortDateValue(l.start);
					if (parsed !== Number.NEGATIVE_INFINITY && (earliest === null || parsed < earliest.parsed)) earliest = { parsed, raw: l.start };
				}
				if (l.officeAddress && (!chosen.officeAddress || l.officeAddress.length > (chosen.officeAddress || '').length)) chosen.officeAddress = l.officeAddress;
				if (l.cityState && (!chosen.cityState || l.cityState.length > (chosen.cityState || '').length)) chosen.cityState = l.cityState;
			}
			chosen.roles = roles;
			if (earliest) chosen.start = earliest.raw;
			merged.push(chosen);
		}
		return merged;
	}

	const linkedEmploymentRegs = (Array.isArray(graphData?.links) ? graphData.links : [])
		.filter((l) => {
			const sourceId = l?.source?.id ?? l?.source;
			const targetId = l?.target?.id ?? l?.target;
			if (sourceId !== d.id || !targetId) return false;
			return l.relationship === 'employed_by' || l.relationship === 'previous_employed_by';
		})
		.map((l) => {
			const targetNode = (Array.isArray(graphData?.nodes) ? graphData.nodes : []).find((n) => n.id === (l?.target?.id ?? l?.target));
			return {
				role: 'B',
				firmId: String(targetNode?.firmId || String((l?.target?.id ?? l?.target) || '').replace(/^firm:/, '') || '').trim(),
				firmName: targetNode?.label || l?.firmName || '',
				start: l?.startDate || '',
				end: l?.endDate || null,
				isCurrent: l.relationship === 'employed_by' && !l?.endDate,
				officeAddress: '',
				cityState: [l?.city, l?.state].filter(Boolean).join(', '),
			};
		});

	const rawCurrent = [
		...(d.currentIAEmployments || []).map((emp) => ({ ...regToEntry(emp, 'IA', true), role: 'IA' })),
		...(d.currentEmployments || []).map((emp) => ({ ...regToEntry(emp, 'B', true), role: 'B' })),
		...linkedEmploymentRegs.filter((entry) => entry.isCurrent),
	];
	const rawPrevious = [
		...(d.previousIAEmployments || []).map((emp) => ({ ...regToEntry(emp, 'IA', false), role: 'IA' })),
		...(d.previousEmployments || []).map((emp) => ({ ...regToEntry(emp, 'B', false), role: 'B' })),
		...linkedEmploymentRegs.filter((entry) => !entry.isCurrent),
	];

	let currentRegistrations = mergeRegistrations(dedupeRegs(rawCurrent));
	let previousRegistrations = mergeRegistrations(dedupeRegs(rawPrevious));

	currentRegistrations.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['start', 'end'] }));
	previousRegistrations.sort((a, b) => (b.end || '').localeCompare(a.end || ''));

	const hasStoredEmps =
		d.currentEmployments?.length || d.previousEmployments?.length || d.currentIAEmployments?.length || d.previousIAEmployments?.length || linkedEmploymentRegs.length;

	let empEntries = [];
	if (hasStoredEmps) {
		empEntries = [
			...(d.currentEmployments || []).map((e) => empToEntry(e, true)),
			...(d.currentIAEmployments || []).map((e) => empToEntry(e, true)),
			...(d.previousEmployments || []).map((e) => empToEntry(e, false)),
			...(d.previousIAEmployments || []).map((e) => empToEntry(e, false)),
		];

		// Merge entries that refer to the same firm CRD (or same normalized name)
		// and pick the oldest (earliest) known start date among duplicates.
		(function mergeSameFirmEntries() {
			const groups = new Map();
			for (const e of empEntries) {
				const firmKey = String(e.firmId || e.firmName || '')
					.trim()
					.toLowerCase();
				if (!firmKey) continue;
				if (!groups.has(firmKey)) groups.set(firmKey, []);
				groups.get(firmKey).push(e);
			}
			const merged = [];
			for (const [key, items] of groups.entries()) {
				if (!items || !items.length) continue;
				if (items.length === 1) {
					merged.push(items[0]);
					continue;
				}
				// reduce to a single entry: choose earliest start, prefer any current record
				let chosen = { ...items[0] };
				let earliestStart = null;
				let anyCurrent = false;
				for (const it of items) {
					if (it.isCurrent) anyCurrent = true;
					if (it.start) {
						const parsed = parseSortDateValue(it.start);
						if (parsed !== Number.NEGATIVE_INFINITY && (earliestStart === null || parsed < earliestStart.parsed)) {
							earliestStart = { parsed, raw: it.start, item: it };
						}
					}
					// prefer longer/more descriptive firmName
					if (it.firmName && it.firmName.length > (chosen.firmName || '').length) chosen.firmName = it.firmName;
					// if no firmId on chosen, take from this
					if (!chosen.firmId && it.firmId) chosen.firmId = it.firmId;
					// prefer iaOnly true if any is IA-only
					if (it.iaOnly) chosen.iaOnly = true;
				}
				if (earliestStart) {
					chosen.start = earliestStart.raw;
				} else {
					// fallback: keep existing start or blank
					chosen.start = chosen.start || '';
				}
				// if any entry indicates current employment, mark as current
				if (anyCurrent) {
					chosen.isCurrent = true;
					chosen.end = null;
				}
				merged.push(chosen);
			}
			// also include any entries that had no firmKey (unlikely) preserving uniqueness by start
			const noKey = empEntries.filter((e) => !String(e.firmId || e.firmName || '').trim()) || [];
			for (const nk of noKey) merged.push(nk);
			empEntries = merged;
		})();

		// After merging by firm we still dedupe exact duplicates by firm+start
		const seen = new Set();
		empEntries = empEntries.filter((e) => {
			const normStart = e.start ? normalizeDateForKey(e.start) : '';
			const key = `${String(e.firmId || e.firmName)
				.trim()
				.toLowerCase()}|${normStart}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	} else {
		const empLinks = links.filter((l) => l.relationship === 'employed_by');
		empEntries = empLinks.map((l) => {
			const firmNode = graphData?.nodes?.find((n) => n.id === (l.target?.id || l.target));
			let resolvedFirmId = l.firmId || null;
			if (!resolvedFirmId && firmNode) {
				// try common id shapes: 'firm:123' or 'firm_123'
				const m = String(firmNode.id || '').match(/(?:firm[:_])(\d+)/);
				if (m) resolvedFirmId = m[1];
				else if (firmNode.firmId) resolvedFirmId = firmNode.firmId;
			}
			return {
				firmName: firmNode?.label || l.firmName || '',
				firmId: resolvedFirmId,
				start: l.startDate || '',
				end: l.endDate || null,
				isCurrent: !l.endDate,
				iaOnly: false,
				addr: firmNode?.officeAddress || l.officeAddress || l.address || d.orphanOfficeAddress || d.orphanMailingAddress || null,
				loc: formatLocationText([l.city, l.state].filter(Boolean).join(', ')),
			};
		});

		// Merge entries that refer to the same firm CRD/name and pick the oldest start date
		(function mergeSameFirmEntriesLinks() {
			const groups = new Map();
			for (const e of empEntries) {
				const firmKey = String(e.firmId || e.firmName || '')
					.trim()
					.toLowerCase();
				if (!firmKey) continue;
				if (!groups.has(firmKey)) groups.set(firmKey, []);
				groups.get(firmKey).push(e);
			}
			const merged = [];
			for (const [key, items] of groups.entries()) {
				if (!items || !items.length) continue;
				if (items.length === 1) {
					merged.push(items[0]);
					continue;
				}
				let chosen = { ...items[0] };
				let earliestStart = null;
				let anyCurrent = false;
				for (const it of items) {
					if (it.isCurrent) anyCurrent = true;
					if (it.start) {
						const parsed = parseSortDateValue(it.start);
						if (parsed !== Number.NEGATIVE_INFINITY && (earliestStart === null || parsed < earliestStart.parsed)) {
							earliestStart = { parsed, raw: it.start, item: it };
						}
					}
					if (it.firmName && it.firmName.length > (chosen.firmName || '').length) chosen.firmName = it.firmName;
					if (!chosen.firmId && it.firmId) chosen.firmId = it.firmId;
				}
				if (earliestStart) chosen.start = earliestStart.raw;
				if (anyCurrent) {
					chosen.isCurrent = true;
					chosen.end = null;
				}
				merged.push(chosen);
			}
			empEntries = merged.concat(empEntries.filter((e) => !String(e.firmId || e.firmName || '').trim()));
		})();

		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	}

	const currentEmploymentEntries = empEntries.filter((e) => e.isCurrent);
	const previousEmploymentEntries = empEntries.filter((e) => !e.isCurrent);
	const allEmploymentEntries = [...currentEmploymentEntries, ...previousEmploymentEntries];

	function normalizeFirmKey(value) {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	function resolveFirmCrdByName(name, providedId) {
		// prefer provided id
		if (providedId) return String(providedId);
		const label = String(name || '').trim();
		if (!label) return null;
		// try find a firm node in graphData by normalized label
		const candidate = graphData?.nodes?.find((n) => n && n.group === 'firm' && normalizeFirmKey(n.label) === normalizeFirmKey(label));
		if (candidate) {
			if (candidate.firmId) return String(candidate.firmId);
			const mid = String(candidate.id || '').match(/(?:firm[:_])(\d+)/);
			if (mid) return mid[1];
		}
		return null;
	}

	function renderFirmNameWithCrd(name, maybeId) {
		const formatted = formatFirmName(name);
		const crd = resolveFirmCrdByName(name, maybeId);
		if (crd) {
			return `<button class='fg-crd-link' data-crd='${esc(String(crd))}' title='View this CRD'>${esc(formatted)}</button>`;
		}
		return esc(formatted || '');
	}

	function findEmploymentMatchForControl(link, firmNode) {
		const controlFirmId = String(firmNode?.firmId || link?.firmId || link?.firm_id || link?.organizationId || link?.orgId || '').trim();
		const controlFirmName = normalizeFirmKey(firmNode?.label || link?.firmName || link?.name || link?.organizationName || link?.legalName || '');

		const byFirmId = controlFirmId ? allEmploymentEntries.find((entry) => String(entry?.firmId || '').trim() === controlFirmId) : null;
		if (byFirmId) return byFirmId;
		if (!controlFirmName) return null;
		return allEmploymentEntries.find((entry) => normalizeFirmKey(entry?.firmName) === controlFirmName) || null;
	}

	const allExams = [...(d.stateExamCategory || []), ...(d.principalExamCategory || []), ...(d.productExamCategory || [])].sort((a, b) =>
		compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['examTakenDate'] }),
	);
	const regStates = Array.isArray(d.registeredStates) ? d.registeredStates.filter(Boolean) : [];
	const licenseCount = regStates.length || (d.registrationCount?.approvedStateRegistrationCount || 0) + (d.registrationCount?.approvedIAStateRegistrationCount || 0);

	function disclosureValueToText(value) {
		if (value == null) return '';
		if (Array.isArray(value)) {
			return value
				.map((item) => disclosureValueToText(item))
				.filter(Boolean)
				.join('; ');
		}
		if (typeof value === 'object') {
			return Object.entries(value)
				.map(([key, nestedValue]) => {
					const nestedText = disclosureValueToText(nestedValue);
					return nestedText ? `${key}: ${nestedText}` : '';
				})
				.filter(Boolean)
				.join(' | ');
		}
		return String(value).trim();
	}

	function disclosureLabelText(key) {
		return String(key || '')
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/[_-]+/g, ' ')
			.trim();
	}

	function disclosureKeyId(key) {
		return String(key || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '');
	}

	function renderDisclosure(dis) {
		const dtype = dis.disclosureType || dis.type || '';
		const ddate = dis.eventDate || dis.date || '';
		const dres = dis.disclosureResolution || dis.resolution || '';
		const dd = dis.disclosureDetail || {};
		const dsource = dis._sourceLabel || '';

		const isObj = dd && typeof dd === 'object' && !Array.isArray(dd);
		const allegs = isObj ? dd['Allegations'] || dd['allegations'] || '' : '';
		const initiatedBy = isObj ? dd['Initiated By'] || dd['initiatedBy'] || '' : '';
		const resolution = isObj ? dd['Resolution'] || dd['resolution'] || '' : '';
		const sanctionText = isObj ? dd['Sanctions'] || dd['sanctions'] || '' : '';
		const sanctionDetails = isObj ? dd['SanctionDetails'] || dd['Sanction Details'] || [] : [];
		const brokerComment = isObj ? dd['Broker Comment'] || dd['brokerComment'] || null : null;
		const settlementAmt = isObj ? dd['Settlement Amount'] || dd['settlementAmount'] || '' : '';
		const docketFDA = isObj ? (dd['DocketNumberFDA'] || '').trim() : '';
		const docketAAO = isObj ? (dd['DocketNumberAAO'] || '').trim() : '';
		const arbDocket = isObj ? dd['arbitrationDocketNumber'] || '' : '';
		const isIAExcl = dis.isIapdExcludedCCFlag === 'Y';
		const isBCExcl = dis.isBcExcludedCCFlag === 'Y';

		const comments =
			Array.isArray(brokerComment) ? brokerComment
			: brokerComment ? [brokerComment]
			: [];
		const sanctionBadges = [...(Array.isArray(sanctionDetails) ? sanctionDetails.map((s) => (typeof s === 'object' ? s.Sanctions || s.sanctions || '' : String(s))) : [])]
			.map((s) => String(s).trim())
			.filter(Boolean);

		const handledDetailKeys = new Set(
			[
				'Allegations',
				'allegations',
				'Initiated By',
				'initiatedBy',
				'Resolution',
				'resolution',
				'Sanctions',
				'sanctions',
				'SanctionDetails',
				'Sanction Details',
				'Broker Comment',
				'brokerComment',
				'Settlement Amount',
				'settlementAmount',
				'DocketNumberFDA',
				'DocketNumberAAO',
				'arbitrationDocketNumber',
			].map((key) => disclosureKeyId(key)),
		);

		const extraDetailRows =
			isObj ?
				Object.entries(dd)
					.map(([key, value]) => ({ key, keyId: disclosureKeyId(key), valueText: disclosureValueToText(value) }))
					.filter(({ keyId, valueText }) => valueText && !handledDetailKeys.has(keyId))
			:	[];

		return `
      <div class='fg-disclosure'>
        <div class='fg-dis-header'>
          <span class='fg-dis-type'>${esc(dtype)}</span>
          ${
						dsource ?
							dsource
								.split(',')
								.map((s) => `<span class='fg-badge inactive'>${esc(s.trim())}</span>`)
								.join(' ')
						:	''
					}
          ${ddate ? `<span class='fg-dis-date'>${esc(ddate)}</span>` : ''}
          ${dres ? `<span class='fg-dis-res ${/final|settled/i.test(dres) ? 'final' : 'pending'}'>${esc(dres)}</span>` : ''}
          ${isIAExcl || isBCExcl ? `<span class='fg-badge inactive' title='Excluded from count'>${isIAExcl ? 'IA-excl' : ''}${isIAExcl && isBCExcl ? ' ' : ''}${isBCExcl ? 'FINRA-excl' : ''}</span>` : ''}
        </div>
        ${initiatedBy ? `<div class='fg-dis-row'><span class='fg-dis-label'>Initiated by:</span> ${esc(initiatedBy)}</div>` : ''}
        ${allegs ? `<div class='fg-dis-row'><span class='fg-dis-label'>Allegations:</span><div class='fg-dis-text'>${esc(allegs)}</div></div>` : ''}
        ${resolution ? `<div class='fg-dis-row'><span class='fg-dis-label'>Resolution:</span> ${esc(resolution)}</div>` : ''}
        ${sanctionText ? `<div class='fg-dis-row'><span class='fg-dis-label'>Sanctions:</span><div class='fg-dis-text'>${esc(sanctionText)}</div></div>` : ''}
        ${settlementAmt ? `<div class='fg-dis-row'><span class='fg-dis-label'>Settlement:</span> <strong>${esc(settlementAmt)}</strong></div>` : ''}
        ${sanctionBadges.length ? `<div class='fg-dis-sanctions'>${sanctionBadges.map((s) => `<span class='fg-badge inactive'>${esc(s)}</span>`).join(' ')}</div>` : ''}
        ${comments.length ? `<div class='fg-dis-row'><span class='fg-dis-label'>Broker comment:</span><div class='fg-dis-text fg-dis-comment'>${comments.map((c) => esc(String(c))).join('<br>')}</div></div>` : ''}
        ${docketFDA || docketAAO || arbDocket ? `<div class='fg-dis-row fg-dis-dockets'>${[docketFDA && `FDA: ${esc(docketFDA)}`, docketAAO && `AAO: ${esc(docketAAO)}`, arbDocket && `Arb: ${esc(arbDocket)}`].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>` : ''}
        ${extraDetailRows.length ? extraDetailRows.map(({ key, valueText }) => `<div class='fg-dis-row'><span class='fg-dis-label'>${esc(disclosureLabelText(key))}:</span><div class='fg-dis-text'>${esc(valueText)}</div></div>`).join('') : ''}
      </div>`;
	}

	const crd = bi.individualId || d.crd || String(d.id).replace(/^person[:_]/, '');
	const brokerCheckSummaryUrl = crd && hasFinraPage ? `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(crd)}` : null;
	const brokerCheckReportUrl = crd && hasFinraPage ? `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(crd)}.pdf` : null;
	const secSummaryUrl = crd && hasSecPage ? `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(crd)}` : null;
	const parentFirmSummaryLinks = buildParentFirmSummaryLinks(d, currentEmploymentEntries);
	const parentFirmSummaryLinksFiltered = (parentFirmSummaryLinks || []).filter((link) => {
		const fid = link?.firmId || (typeof link?.href === 'string' ? String(link.href).split('/').pop() : null);
		const rawFirmId =
			fid ?
				String(fid)
					.replace(/^firm[:_]/, '')
					.replace(/^node[:_]/, '')
					.trim()
			:	'';
		const firmNode = graphData?.nodes?.find((n) => {
			const nid = String(n?.firmId || n?.id || '')
				.replace(/^firm[:_]/, '')
				.replace(/^node[:_]/, '')
				.trim();
			return nid && rawFirmId && nid === rawFirmId;
		});
		if (link.className === 'bc') {
			// Only show FINRA parent firm links when we can locate the firm node
			// in the local graph and it indicates FINRA presence.
			if (firmNode) return hasFirmFinraPresence(firmNode);
			return false;
		}
		if (link.className === 'sec') {
			// Only show SEC parent firm links when we can locate the firm node
			// in the local graph and it indicates SEC presence.
			if (firmNode) return hasFirmSecPresence(firmNode);
			return false;
		}
		return true;
	});

	return `
    <div class='fg-sb-header individual'>
		<div class='fg-sb-title'>${esc(normalizePersonLabel(d.label || [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ')))}</div>
      <div class='fg-sb-badges'>
        ${scopeBadgesHtml}
        ${stubBadge}
        ${disclosureCount ? `<span class='fg-badge inactive'>${disclosureCount} disclosure${disclosureCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <div class='fg-sb-body fg-sb-body--person'>
      <div class='fg-ext-links'>
        ${brokerCheckSummaryUrl ? `<a class='fg-ext-link bc' href='${brokerCheckSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Summary</a>` : ''}
        ${brokerCheckReportUrl ? `<a class='fg-ext-link bc' href='${brokerCheckReportUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Detailed Report (PDF)</a>` : ''}
        ${secSummaryUrl ? `<a class='fg-ext-link sec' href='${secSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; SEC AdvisorInfo Summary</a>` : ''}
		${parentFirmSummaryLinksFiltered.map((link) => `<a class='fg-ext-link ${link.className}' href='${esc(link.href)}' target='_blank' rel='noopener noreferrer'>&#x2197; ${esc(link.label)}</a>`).join('')}
		${dashboardHref ? `<a class='fg-ext-link dashboard' href='${esc(dashboardHref)}' onclick='event.stopPropagation()'>Dashboard details</a>` : ''}
      </div>

      ${bi.individualId ? row('CRD', `<code>${bi.individualId}</code>`) : ''}
	${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${d.orphanPosition ? row('Position', esc(String(d.orphanPosition))) : ''}
      ${d.orphanFirmName ? row('Affiliated Firm', esc(String(d.orphanFirmName))) : ''}
      ${d.orphanParentCrd ? row('Parent Firm CRD', `<button type='button' class='fg-crd-link' data-crd='${esc(String(d.orphanParentCrd))}' data-crd-type='${d.orphanParentType === 'individual' ? 'individual' : 'firm'}'>Firm #${esc(String(d.orphanParentCrd))}</button>`) : ''}
      ${aliases.length ? row('Also known as', esc(aliases.join('; '))) : ''}
      ${
				d.yearsExperience != null ? row('Years of Experience', esc(String(d.yearsExperience)))
				: d.daysInIndustry != null ? row('Days in Industry', d.daysInIndustry.toLocaleString())
				: ''
			}
      ${typeof d.firmCount === 'number' ? row('Firms (all time)', esc(String(d.firmCount))) : ''}
      ${licenseCount ? row('State Licenses', esc(String(licenseCount))) : ''}
      ${row('Disclosures', esc(String(disclosureCount)))}
	      ${d.primaryOffice?.address ? row('Primary Office', esc(formatLocationText(d.primaryOffice.address)), 'fg-detail-row--stacked') : ''}
      ${
				d.registrationCount ?
					`
        ${d.registrationCount.approvedFinraRegistrationCount != null ? row('FINRA Registrations', esc(String(d.registrationCount.approvedFinraRegistrationCount))) : ''}
        ${d.registrationCount.approvedSRORegistrationCount != null ? row('SRO Registrations', esc(String(d.registrationCount.approvedSRORegistrationCount))) : ''}
        ${d.registrationCount.approvedStateRegistrationCount != null ? row('State Broker Lic.', esc(String(d.registrationCount.approvedStateRegistrationCount))) : ''}
        ${d.registrationCount.approvedIAStateRegistrationCount != null ? row('State (IA) Lic.', esc(String(d.registrationCount.approvedIAStateRegistrationCount))) : ''}
      `
				:	''
			}

	${currentEmploymentEntries.length || previousEmploymentEntries.length ? `<div class='fg-section-title fg-section-title--sticky'>Employment</div>` : ''}

      ${
				currentEmploymentEntries.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Current Employment (${currentEmploymentEntries.length})</div>
            <div class='fg-timeline'>
              ${currentEmploymentEntries
								.map((e) => {
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class='fg-tl-entry active-pos'>
																			<span class='fg-tl-firm'>${renderFirmNameWithCrd(e.firmName, e.firmId)}${e.bdSecNumber ? ` <small>SEC#${esc(String(e.bdSecNumber))}</small>` : ''}</span>
																					<span class='fg-tl-dates'> ${esc(e.start || '–')} → ${esc(e.end || 'present')} </span>
																					${detailLine ? `<span class='fg-tl-loc'>${esc(detailLine)}</span>` : ''}
																					${scopeTags.length ? `<span class='fg-tl-loc' style='color:var(--text-m)'>${esc(scopeTags.join(' · '))}</span>` : ''}
																				</div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				previousEmploymentEntries.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Previous Employment (${previousEmploymentEntries.length})</div>
	            <div class='fg-timeline fg-timeline--previous'>
              ${previousEmploymentEntries
								.map((e) => {
									const cls = `fg-tl-entry${e.isCurrent ? ' active-pos' : ''}`;
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class='${cls}'>
																			<span class='fg-tl-firm'>${renderFirmNameWithCrd(e.firmName, e.firmId)}${e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ''}</span>
																					<span class='fg-tl-dates'> ${esc(e.start || '–')} → ${esc(e.end || 'present')} </span>
																					${detailLine ? `<span class='fg-tl-loc'>${esc(detailLine)}</span>` : ''}
																					${scopeTags.length ? `<span class='fg-tl-loc' style='color:var(--text-m)'>${esc(scopeTags.join(' · '))}</span>` : ''}
																					${e.expelledDate ? `<span class='fg-badge inactive'>Expelled ${esc(e.expelledDate)}</span>` : ''}
																				</div>`;
								})
								.join('')}
            </div>`
				:	`<div class='fg-section-title fg-section-title--sticky'>Previous Employment</div>
            <div class='fg-empty-state' style='margin-top:8px'>No previous employment records found for this profile.</div>`
			}

      ${
				currentRegistrations.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Current Registrations</div>
            <div class='fg-timeline'>
              ${currentRegistrations
								.map(
									(reg) => `
                <div class='fg-tl-entry active-pos'>
									<span class='fg-tl-firm'>${renderRegistrationRole(reg.roles || reg.role)} ${
										reg.firmId ?
											`<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>${esc(formatFirmName(reg.firmName))}</button> (<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>CRD#${esc(String(reg.firmId))}</button>)`
										:	esc(formatFirmName(reg.firmName))
									}</span>
                  ${
										reg.officeAddress ? `<span class='fg-tl-loc'>${esc(reg.officeAddress)}</span>`
										: reg.cityState ? `<span class='fg-tl-loc'>${esc(reg.cityState)}</span>`
										: ''
									}
				  ${reg.start ? `<span class='fg-tl-dates'> Registered since ${esc(reg.start)} </span>` : ''}
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				previousRegistrations.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Previous Registrations (${previousRegistrations.length})</div>
	            <div class='fg-timeline fg-timeline--previous'>
              ${previousRegistrations
								.map(
									(reg) => `
                <div class='fg-tl-entry'>
									<span class='fg-tl-firm'>${renderRegistrationRole(reg.roles || reg.role, { inactive: true })} ${
										reg.firmId ?
											`<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>${esc(formatFirmName(reg.firmName))}</button> (<button class='fg-crd-link' data-crd='${esc(String(reg.firmId))}' title='View this CRD'>CRD#${esc(String(reg.firmId))}</button>)`
										:	esc(formatFirmName(reg.firmName))
									}</span>
                  ${reg.cityState ? `<span class='fg-tl-loc'>${esc(reg.cityState)}</span>` : ''}
                  <span class='fg-tl-dates'>${esc(reg.start || '–')} → ${esc(reg.end || 'present')}</span>
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				d.registeredSROs?.length ?
					`<details class='fg-section-toggle'>
			      <summary class='fg-section-title fg-section-title--sticky'>Registered SROs (${d.registeredSROs.length})</summary>
              ${d.registeredSROs
								.map((sro) => {
									const name = esc(sro.sro || sro.name || '');
									const status = sro.status ? ` <span class='fg-badge fg-sro-status-badge ${/approved/i.test(sro.status) ? 'active' : 'inactive'}'>${esc(sro.status)}</span>` : '';
									const categories =
										Array.isArray(sro.CategoriesList) ? sro.CategoriesList
										: typeof sro.CategoriesList === 'string' ? [sro.CategoriesList]
										: [];
									const categoryItems = categories
										.flatMap((item) => String(item).split(/\s*[;,]\s*/))
										.map((item) => item.trim())
										.filter(Boolean);
									const cats = categoryItems.length ? `<ul class='fg-sro-cat-list'>${categoryItems.map((cat) => `<li>${esc(cat)}</li>`).join('')}</ul>` : '';
									return `<div class='fg-detail-row'><span class='fg-label'>${name}${status}</span>${cats}</div>`;
								})
								.join('')}
            </details>`
				:	''
			}

      ${
				regStates.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Registered States</div>
            <div class='fg-states-grid'>
              ${regStates
								.map((s) => {
									const stateStr = typeof s === 'object' ? s.state || '' : String(s);
									const scope = typeof s === 'object' ? s.regScope || '' : '';
									const scopeDisplay = /^bc$/i.test(String(scope).trim()) ? '' : String(scope).trim();
									const status = typeof s === 'object' ? s.status || '' : '';
									const regDate = typeof s === 'object' ? s.regDate || '' : '';
									const cls = /approved/i.test(status) ? 'active' : 'inactive';
									return `<span class='fg-state-pill ${cls}' title='${esc([scopeDisplay, status, regDate ? `since ${regDate}` : ''].filter(Boolean).join(' | '))}'>${esc(stateStr)}${scopeDisplay ? ` <small>${esc(scopeDisplay)}</small>` : ''}</span>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				controlLinks.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Control Positions</div>
            ${controlLinks
							.slice()
							.sort((a, b) =>
								compareCurrentFirstByDates(
									{
										isCurrent: !a.endDate && !a.registrationEndDate && !a.toDate,
										end: a.endDate || a.registrationEndDate || a.toDate,
										start: a.startDate || a.registrationBeginDate || a.fromDate || a.effectiveDate || a.date,
									},
									{
										isCurrent: !b.endDate && !b.registrationEndDate && !b.toDate,
										end: b.endDate || b.registrationEndDate || b.toDate,
										start: b.startDate || b.registrationBeginDate || b.fromDate || b.effectiveDate || b.date,
									},
									{ dateKeys: ['end', 'start'] },
								),
							)
							.map((l) => {
								const firmNode = graphData?.nodes?.find((n) => n.id === (l.target?.id || l.target));
								const employmentMatch = findEmploymentMatchForControl(l, firmNode);
								const firmAddress =
									firmNode?.officeAddress ||
									l.officeAddress ||
									l.address ||
									employmentMatch?.addr ||
									[l.street1, l.street2, l.city, l.state, l.postalCode, l.zipCode, l.zip, l.country].filter(Boolean).join(', ') ||
									null;
								const firmStatus =
									firmNode?.firmStatus || l.firmStatus || l.status || l.registrationStatus || employmentMatch?.employmentStatus || employmentMatch?.firmBCScope || null;
								const secNumber =
									firmNode?.bdSecNumber || firmNode?.iaSecNumber || l.bdSecNumber || l.iaSecNumber || employmentMatch?.bdSecNumber || employmentMatch?.iaSECNumber || null;
								const startDate = l.startDate || l.registrationBeginDate || l.fromDate || l.effectiveDate || l.date || employmentMatch?.start || null;
								const endDate = l.endDate || l.registrationEndDate || l.toDate || employmentMatch?.end || null;
								const dateRange = startDate ? `${esc(startDate)} → ${esc(endDate || 'present')}` : null;
								const location =
									l.location ||
									employmentMatch?.loc ||
									(l.city || l.officeCity || l.state || l.officeState ? [l.city || l.officeCity, l.state || l.officeState].filter(Boolean).join(', ') : null);
								const controlFirmId = firmNode?.firmId || l.firmId || employmentMatch?.firmId || null;
								const controlFirmIdStr = controlFirmId ? String(controlFirmId).trim() : '';
								const entryBody = `<span class='fg-tl-firm'>${renderFirmNameWithCrd(firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '', controlFirmId)}${secNumber ? ` <small>SEC#${esc(String(secNumber))}</small>` : ''}</span>
                  ${dateRange ? `<span class='fg-tl-dates'>${dateRange}</span>` : ''}
                  ${firmStatus ? `<span class='fg-tl-status'>${esc(firmStatus)}</span>` : ''}
                  ${l.position ? `<span class='fg-tl-loc'>${esc(l.position)}</span>` : ''}
                  ${location ? `<span class='fg-tl-loc'>${esc(location)}</span>` : ''}
                  ${firmAddress ? `<span class='fg-tl-loc'>${esc(firmAddress)}</span>` : ''}`;
								if (controlFirmIdStr) {
									return `<button type='button' class='fg-tl-entry fg-card-clickable fg-crd-link active-pos' data-crd='${esc(controlFirmIdStr)}' data-crd-type='firm'>${entryBody}</button>`;
								}
								const searchName = firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '';
								return `<button type='button' class='fg-tl-entry fg-card-clickable active-pos' data-search-query='${esc(searchName)}'>${entryBody}</button>`;
							})
							.join('')}`
				:	''
			}

      ${
				allExams.length ?
					`<div class='fg-section-title fg-section-title--sticky'>Qualifications &amp; Exams (${allExams.length})</div>
            <div class='fg-timeline'>
              ${allExams
								.map((ex) => {
									const examScopeDisplay = /^bc$/i.test(String(ex.examScope || '').trim()) ? '' : String(ex.examScope || '').trim();
									return `<div class='fg-tl-entry'>
                  <span class='fg-tl-firm'>${esc(ex.examCategory || '')} – ${esc(ex.examName || '')}</span>
				  ${ex.examTakenDate ? `<span class='fg-tl-dates'> Passed: ${esc(ex.examTakenDate)} </span>` : ''}
                  ${examScopeDisplay ? `<span class='fg-tl-loc'>${esc(examScopeDisplay)}</span>` : ''}
                </div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				allDisclosures.length ?
					`<details class='fg-section-toggle'>
			<summary class='fg-section-title fg-section-title--sticky'>Disclosures (${allDisclosures.length})</summary>
            ${allDisclosures.map(renderDisclosure).join('')}
          </details>`
				: d.disclosureFlag === 'Y' || d.iaDisclosureFlag === 'Y' ?
					`<details class='fg-section-toggle'>
			<summary class='fg-section-title fg-section-title--sticky'>Disclosures</summary>
            <p class='fg-sb-note'>FINRA or SEC marks this record as having disclosures, but the current API response did not include structured disclosure bodies for this profile.</p>
            <div class='fg-ext-links'>
              ${brokerCheckSummaryUrl ? `<a class='fg-ext-link bc' href='${brokerCheckSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open FINRA Summary</a>` : ''}
              ${brokerCheckReportUrl ? `<a class='fg-ext-link bc' href='${brokerCheckReportUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open FINRA Detailed Report (PDF)</a>` : ''}
              ${secSummaryUrl ? `<a class='fg-ext-link sec' href='${secSummaryUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; Open SEC AdvisorInfo Summary</a>` : ''}
            </div>
          </details>`
				:	''
			}
    </div>
  `;
}

export function renderFirmDetail(d: any) {
	// Scraped-only / non-live firm reference (e.g. employer pulled from an individual's
	// Form BD page with no independent BrokerCheck/IAPD firm detail). Link out to the
	// parent FINRA detail page instead of hiding external links.
	if (d.orphan && typeof d.orphan === 'object') {
		const orphan = d.orphan;
		const firmId = String(d.firmId || orphan.firmId || String(d.id || '').replace(/^firm[:_]/, '') || '').trim();
		const firmName = formatFirmName(orphan.firmName || d.label || d.firmName || '');
		const parentCrd = String(orphan.parentCrd || d.orphanParentCrd || '').trim();
		const parentType = String(orphan.parentType || d.orphanParentType || 'individual')
			.trim()
			.toLowerCase();
		const parentIsIndividual = parentType === 'individual';
		const parentName = formatEntityName(
			parentIsIndividual ? orphan.name || d.orphanName || `CRD ${parentCrd}` : orphan.firmName || firmName || `Firm ${parentCrd}`,
			parentIsIndividual ? 'individual' : 'firm',
		);
		const firmStatusRaw = String(orphan.firmStatus || orphan.status || d.firmStatus || 'Legacy / non-live').trim();
		const firmIsInactive = /inactive|terminated|revoked|suspended|notinscope|legacy|non-?live/i.test(firmStatusRaw.replace(/\s+/g, ''));
		const officeObj = orphan.officeAddress && typeof orphan.officeAddress === 'object' ? (orphan.officeAddress as Record<string, any>) : null;
		const mailingObj = orphan.mailingAddress && typeof orphan.mailingAddress === 'object' ? (orphan.mailingAddress as Record<string, any>) : null;
		const officeAddress = formatLocationText(
			officeObj
				? [officeObj.street1 || officeObj.street, officeObj.street2, officeObj.city, officeObj.state, officeObj.postalCode || officeObj.zipCode || officeObj.zip, officeObj.country]
						.filter(Boolean)
						.join(', ')
				: typeof orphan.officeAddress === 'string'
					? orphan.officeAddress
					: '',
		);
		const mailingAddress = formatLocationText(
			mailingObj
				? [
						mailingObj.street1 || mailingObj.street,
						mailingObj.street2,
						mailingObj.city,
						mailingObj.state,
						mailingObj.postalCode || mailingObj.zipCode || mailingObj.zip,
						mailingObj.country,
					]
						.filter(Boolean)
						.join(', ')
				: typeof orphan.mailingAddress === 'string'
					? orphan.mailingAddress
					: '',
		);
		const parentFinraUrl =
			parentCrd ?
				`https://brokercheck.finra.org/${parentIsIndividual ? 'individual' : 'firm'}/summary/${encodeURIComponent(parentCrd)}`
			:	null;
		const parentSecUrl = parentCrd && !parentIsIndividual ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(parentCrd)}` : null;
		const dashboardHref = buildDashboardDetailsHref({ ...d, firmId, group: 'firm' });
		const parentButton =
			parentCrd ?
				`<button class='fg-crd-link' data-crd='${esc(parentCrd)}' data-crd-type='${parentIsIndividual ? 'individual' : 'firm'}' title='View this CRD'>${esc(parentName || `CRD ${parentCrd}`)}</button>`
			:	esc(parentName || '');
		const parentCard =
			parentCrd ?
				`<div class='fg-section-title fg-section-title--sticky'>Referenced from</div>
            <div class='fg-timeline'>
              <div class='fg-tl-entry'>
                <span class='fg-tl-firm'>${parentButton} <small>CRD#${esc(parentCrd)}</small></span>
                ${orphan.position ? `<span class='fg-tl-dates'>${esc(formatUiText(orphan.position))}</span>` : ''}
                <span class='fg-tl-loc' style='color:var(--text-m)'>Scraped reference · no live firm detail page</span>
              </div>
            </div>`
			:	'';

		return `
    <div class='fg-sb-header firm'>
      <div class='fg-sb-title'>${esc(firmName || `Firm ${firmId}`)}</div>
      ${firmId ? `<div class='fg-sb-crd'>CRD#: ${esc(firmId)}</div>` : ''}
      <div class='fg-sb-badges'>
        <span class='fg-badge ${firmIsInactive ? 'inactive' : 'active'}' title='Scraped firm registration status'>${esc(firmStatusRaw || (firmIsInactive ? 'Legacy / non-live' : 'Active'))}</span>
        <span class='fg-badge stub' title='Firm known only via scraped employment / Form BD reference'>Scraped firm reference</span>
      </div>
    </div>
    <div class='fg-sb-body'>
      <div class='fg-ext-links'>
        ${
					// No live firm BrokerCheck/IAPD detail — link FINRA/SEC to the parent entity instead.
					parentFinraUrl ? `<a class='fg-ext-link bc' href='${parentFinraUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA profile</a>` : ''
				}
        ${parentSecUrl ? `<a class='fg-ext-link sec' href='${parentSecUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; SEC profile</a>` : ''}
        ${dashboardHref ? `<a class='fg-ext-link dashboard' href='${esc(dashboardHref)}' onclick='event.stopPropagation()'>Dashboard details</a>` : ''}
      </div>
      ${officeAddress ? row('Main Address', esc(officeAddress), 'fg-detail-row--stacked') : ''}
      ${mailingAddress && mailingAddress !== officeAddress ? row('Mailing', esc(mailingAddress), 'fg-detail-row--stacked') : ''}
      ${orphan.phone ? row('Phone', esc(String(orphan.phone))) : ''}
      ${parentCard}
      <p class='fg-sb-note'>This firm has no independent live FINRA/SEC detail page in cache. The FINRA profile link opens the parent ${parentIsIndividual ? 'individual' : 'firm'} BrokerCheck page that referenced it.</p>
    </div>`;
	}

	const registrationStatusEntries = Array.isArray(d.registrationStatus) ? d.registrationStatus.filter((entry: any) => entry && typeof entry === 'object') : [];
	const primaryRegistrationStatusEntry =
		registrationStatusEntries.find((entry: any) => /sec/i.test(String(entry?.secJurisdiction || entry?.jurisdiction || entry?.state || entry?.name || ''))) ||
		registrationStatusEntries[0] ||
		null;
	const registrationStatusText =
		primaryRegistrationStatusEntry ?
			String(primaryRegistrationStatusEntry.status || primaryRegistrationStatusEntry.registrationStatus || primaryRegistrationStatusEntry.regStatus || '').trim()
		:	'';
	const firmStatusText = d.firmStatus ? String(d.firmStatus).trim() : registrationStatusText;
	const statusDate =
		d.firmStatusDate ||
		(primaryRegistrationStatusEntry ?
			String(
				primaryRegistrationStatusEntry.effectiveDate ||
					primaryRegistrationStatusEntry.effectiveDateText ||
					primaryRegistrationStatusEntry.effective ||
					primaryRegistrationStatusEntry.date ||
					'',
			).trim()
		:	'');
	const statusText = firmStatusText ? capitalize(firmStatusText.toLowerCase()) : '';
	const statusIsActive = firmStatusText ? /\bactive\b|\bapproved\b/i.test(firmStatusText) : false;
	const statusIsTerminated = firmStatusText ? /terminated|inactive|revoked|suspended/i.test(firmStatusText) : false;
	const statusClass =
		statusIsActive ? 'active'
		: statusIsTerminated ? 'terminated'
		: 'inactive';
	const hasSecRegistrationBadge =
		Array.isArray(d.registrationStatus) &&
		d.registrationStatus.some((entry: any) => /sec/i.test(String(entry?.secJurisdiction || entry?.jurisdiction || entry?.state || entry?.name || '')));
	const displayStatusText = hasSecRegistrationBadge && firmStatusText ? `SEC ${statusText}` : statusText;
	const statusBadge = firmStatusText ? `<span class='fg-badge ${statusClass}'>${esc(displayStatusText)}${statusDate ? ` ${statusDate}` : ''}</span>` : '';
	const legacyBadge = d.isLegacy === 'Y' ? `<span class='fg-badge inactive'>PR Previously Registered Brokerage Firm</span>` : '';
	const scopeBadge =
		d.bcScope ?
			`<span class='fg-badge ${/\b(active|approved)\b/i.test(String(d.bcScope)) ? 'active' : 'inactive'}'>${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`
		:	'';
	const sros = Array.isArray(d.selfRegulatoryOrgs) && d.selfRegulatoryOrgs.length ? d.selfRegulatoryOrgs.join(', ') : 'N/A';
	const states = Array.isArray(d.activeStates) && d.activeStates.length ? d.activeStates.join(', ') : 'N/A';
	const firmId = d.firmId || String(d.id).replace(/^firm[:_]/, '');
	const normalizeSecFirmId = (value: string | number | null | undefined) => {
		const raw = String(value || '').trim();
		if (!raw) return '';
		if (/^8-\d+$/i.test(raw)) return raw;
		if (/^\d+$/.test(raw)) return `8-${raw}`;
		return raw;
	};
	const secFirmId = normalizeSecFirmId(d.iaSecNumber || d.iaSECNumber || d.bdSecNumber || d.bdSECNumber || d.basicInformation?.iaSecNumber || d.basicInformation?.iaSECNumber || d.basicInformation?.bdSecNumber || d.basicInformation?.bdSECNumber);
	const crdSec = [firmId ? `CRD#: ${firmId}` : null, secFirmId ? `SEC#: ${secFirmId}` : null].filter(Boolean).join(' / ');
	
	const secSummaryUrl = firmId ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}` : null;
	const secDocumentUrl = secFirmId ? `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(secFirmId)}/PDF/${encodeURIComponent(secFirmId)}.pdf` : null;
	const secBrochureUrl = firmId ? `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(firmId)}` : null;

	const hasFinraPage = hasFirmFinraPresence(d);
	const hasSecPage = hasFirmSecPresence(d);

	const secDocumentLinks =
		hasSecPage ?
			(() => {
				const defaultLinks =
					secFirmId ?
						[
							{ label: 'SEC AdvisorInfo Summary', href: secSummaryUrl },
							{ label: 'Latest Form ADV filed', href: `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(secFirmId)}/PDF/${encodeURIComponent(secFirmId)}.pdf` },
							{ label: 'SEC firm brochure', href: `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(secFirmId)}` },
							{ label: 'SEC Form CRS', href: `https://reports.adviserinfo.sec.gov/crs/crs_${encodeURIComponent(secFirmId)}.pdf` },
						]
					:	[];

				if (!Array.isArray(d.secDocumentLinks) || !d.secDocumentLinks.length) return defaultLinks;

				return d.secDocumentLinks.map((link: any) => {
					const label = String(link?.label || '').trim();
					const existingHref = String(link?.href || '').trim() || null;
					if (!label) return link;
					if (/^SEC AdvisorInfo Summary$/i.test(label)) return { ...link, href: secSummaryUrl || existingHref };
					if (/^Latest Form ADV filed$/i.test(label)) return link;
					if (/^SEC firm brochure$/i.test(label)) return link;
					if (/^SEC Form CRS$/i.test(label)) return link;
					return link;
				});
			})()
		:	[];
	const secSummaryDescription = hasSecPage && d.secSummaryDescription ? String(d.secSummaryDescription).trim() : '';
	const showBrokerCheckSummary = hasFinraPage;
	const showSec = hasSecPage;
	const dashboardHref = buildDashboardDetailsHref(d);
	function renderRegistrationStatusRows() {
		const entries = Array.isArray(d.registrationStatus) ? d.registrationStatus.filter((entry: any) => entry && typeof entry === 'object') : [];
		const fallbackEntries =
			entries.length ? entries
			: d.firmStatus ? [{ secJurisdiction: 'SEC', status: d.firmStatus, effectiveDate: d.firmStatusDate }]
			: [];
		if (!fallbackEntries.length) return '';
		return `
			<div class='fg-section-title fg-section-title--sticky'>Registration Status</div>
			${fallbackEntries
				.map((entry: any) => {
					const jurisdiction = String(entry.secJurisdiction || entry.jurisdiction || entry.state || entry.name || 'SEC').trim() || 'SEC';
					const status = String(entry.status || entry.registrationStatus || entry.regStatus || '').trim();
					const effectiveDate = String(entry.effectiveDate || entry.effectiveDateText || entry.effective || entry.date || '').trim();
					return `
						<div class='fg-detail-row'>
							<span class='fg-label'>SEC / Jurisdiction</span>
							<span>${esc(jurisdiction)}</span>
						</div>
						<div class='fg-detail-row'>
							<span class='fg-label'>Registration Status</span>
							<span>${status ? esc(status) : '–'}</span>
						</div>
						<div class='fg-detail-row'>
							<span class='fg-label'>Effective Date</span>
							<span>${effectiveDate ? esc(effectiveDate) : '–'}</span>
						</div>`;
				})
				.join('')}`;
	}

	function renderNoticeFilingsRows() {
		const entries = Array.isArray(d.noticeFilings) ? d.noticeFilings.filter((entry: any) => entry && typeof entry === 'object') : [];
		if (!entries.length) return '';
		return `
			<div class='fg-section-title fg-section-title--sticky'>Notice Filings</div>
			${entries
				.map((entry: any) => {
					const jurisdiction = String(entry.jurisdiction || entry.state || entry.name || '').trim();
					const effectiveDate = String(entry.effectiveDate || entry.effectiveDateText || entry.effective || entry.date || '').trim();
					const status = String(entry.status || entry.registrationStatus || entry.regStatus || '').trim();
					const statusClass =
						/active|approved|registered/i.test(status) ? 'active'
						: /terminated|inactive|revoked|suspended/i.test(status) ? 'terminated'
						: 'inactive';
					const badge = status ? `<span class='fg-badge ${statusClass}'>${esc(status)}</span>` : '';
					return `
						<div class='fg-detail-row'>
							<span class='fg-label'>Jurisdiction</span>
							<span>${esc(jurisdiction || '–')}</span>
						</div>
						<div class='fg-detail-row'>
							<span class='fg-label'>Effective Date</span>
							<span>${effectiveDate ? esc(effectiveDate) : '–'}</span>
						</div>
						<div class='fg-detail-row'>
							<span class='fg-label'>Status</span>
							<span>${badge || '–'}</span>
						</div>`;
				})
				.join('')}`;
	}

	function renderCrsRows() {
		if (!d.crs) return '';
		return `
			<div class='fg-section-title'>CRS</div>
			<div class='fg-detail-row'>
				<span class='fg-label'>CRS Type</span>
				<span>${esc(d.crs.crsType || '–')}</span>
			</div>
			<div class='fg-detail-row'>
				<span class='fg-label'>File ID</span>
				<span>${esc(d.crs.fileId || '–')}</span>
			</div>`;
	}

	function renderDisclosureFlagRows() {
		if (!d.bdDisclosureFlag && !d.iaDisclosureFlag) return '';
		return `
			<div class='fg-section-title'>Disclosures</div>
			${
				d.bdDisclosureFlag ?
					`
			<div class='fg-detail-row'>
				<span class='fg-label'>BD Disclosure Flag</span>
				<span>${esc(d.bdDisclosureFlag)}</span>
			</div>`
				:	''
			}
			${
				d.iaDisclosureFlag ?
					`
			<div class='fg-detail-row'>
				<span class='fg-label'>IA Disclosure Flag</span>
				<span>${esc(d.iaDisclosureFlag)}</span>
			</div>`
				:	''
			}`;
	}

	function renderBrochuresRows() {
		if (!d.brochures) return '';
		const details = Array.isArray(d.brochures.brochuredetails) ? d.brochures.brochuredetails : [];
		return `
			<div class='fg-section-title fg-section-title--sticky'>Brochures</div>
			<div class='fg-detail-row'>
				<span class='fg-label'>Part 2 Exempt</span>
				<span>${esc(d.brochures.part2ExemptFlag || '–')}</span>
			</div>
			${
				details.length ?
					`
			<div class='fg-timeline'>
				${details
					.map(
						(b: any) => `
					<div class='fg-tl-entry'>
						<span class='fg-tl-firm'>${esc(b.brochureName || '–')} <small>(ID: ${esc(String(b.brochureVersionID || '–'))})</small></span>
						${b.dateSubmitted ? `<span class='fg-tl-dates'>Submitted: ${esc(b.dateSubmitted)}</span>` : ''}
						${b.lastConfirmed ? `<span class='fg-tl-loc'>Last Confirmed: ${esc(b.lastConfirmed)}</span>` : ''}
					</div>
				`,
					)
					.join('')}
			</div>`
				:	''
			}`;
	}

	const officeAddressRaw = String(d.officeAddress || '').trim();
	const officeAddress = /^(?:-|n\/?a|na|none|null|undefined)$/i.test(officeAddressRaw) ? '' : officeAddressRaw;
	const hasOfficeAddress = Boolean(officeAddress);
	const businessPhone = String(d.businessPhone || '').trim();
	const SIDEBAR_CONNECTIONS_PREVIEW_LIMIT = 24;
	// Employment current/previous rosters are dashboard-only. Side panel keeps Form BD owners.

	return `
		<div class='fg-sb-header firm'>
			<div class='fg-sb-title'>${esc(formatFirmName(d.label))}</div>
			${crdSec ? `<div class='fg-sb-crd'>${crdSec}</div>` : ''}
      <div class='fg-sb-badges'>
        ${legacyBadge}
        ${(() => {
					if (d.firmSize && d.firmStatus) {
						const combined = `${esc(firmSizeLabel(d.firmSize))} - ${esc(statusText)}`;
						return `<span class='fg-badge ${statusClass}'>${combined}</span>`;
					}
					return `${statusBadge}${d.firmSize ? `<span class='fg-badge'>${esc(firmSizeLabel(d.firmSize))}</span>` : ''}`;
				})()}
        ${scopeBadge}
      </div>
    </div>
    <div class='fg-sb-body'>
      <div class='fg-ext-links'>
        ${showBrokerCheckSummary ? `<a class='fg-ext-link bc' href='https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}' target='_blank' rel='noopener noreferrer'>&#x2197; FINRA Summary</a>` : ''}
		${showSec ? secDocumentLinks.map((link) => (link?.href ? `<a class='fg-ext-link sec' href='${esc(link.href)}' target='_blank' rel='noopener noreferrer'>&#x2197; ${esc(link.label)}</a>` : '')).join('') : ''}
        ${dashboardHref ? `<a class='fg-ext-link dashboard' href='${esc(dashboardHref)}' onclick='event.stopPropagation()'>Dashboard details</a>` : ''}
      </div>
      ${secSummaryDescription ? `<div class='fg-section-title'>SEC summary</div><p class='fg-sb-note'>${esc(secSummaryDescription)}</p>` : ''}
      ${d.isLegacy === 'Y' ? `<p class='fg-sb-note'>Not currently registered as broker. FINRA contains only limited information about this firm.</p>` : ''}
      ${
				hasOfficeAddress || businessPhone ?
					`
      <div class='fg-section-title'>Contact</div>
      ${hasOfficeAddress ? row('Address', esc(officeAddress)) : ''}
      ${businessPhone ? row('Phone', esc(businessPhone)) : ''}
      `
				:	''
			}
      <div class='fg-section-title'>Registration</div>
	${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${showSec ? renderRegistrationStatusRows() : ''}
      ${showSec ? renderNoticeFilingsRows() : ''}
      ${renderDisclosureFlagRows()}
      ${renderCrsRows()}
      ${renderBrochuresRows()}
      ${d.districtName ? row('FINRA District', esc(d.districtName)) : ''}
      ${row('Company Type', esc(d.firmType || 'N/A'))}
      ${row('Self-Regulatory Orgs', esc(sros))}
      ${row(
				'U.S. States &amp; Territories',
				states !== 'N/A' ? esc(states)
				: d.activeStates?.length ? `${d.activeStates.length} states/territories`
				: 'N/A',
			)}
      ${row('Regulator', esc(d.regulator || '–'))}
      ${
				Array.isArray(d.directOwners) && d.directOwners.length ?
					`
      <div class='fg-section-title'>Direct Owners &amp; Executive Officers (${d.directOwners.length})</div>
      <div class='fg-timeline'>
        ${d.directOwners
					.slice(0, SIDEBAR_CONNECTIONS_PREVIEW_LIMIT)
					.map((owner: any) => {
						const name = owner.legalName || owner.name || `Person ${owner.crdNumber || owner.crd || ''}`;
						const position = owner.position || '';
						const ownership = owner.ownershipCode || owner.ownership || '';
						const crd = owner.crdNumber || owner.crd || '';
						return `<div class='fg-tl-entry'>
            <span class='fg-tl-firm'>${esc(name)}${crd ? ` <small>(CRD# ${esc(String(crd))})</small>` : ''}</span>
            ${position ? `<span class='fg-tl-dates'>${esc(position)}</span>` : ''}
            ${ownership ? `<span class='fg-tl-loc'>Ownership: ${esc(ownership)}</span>` : ''}
          </div>`;
					})
					.join('')}
      </div>
      `
				:	''
			}
      <div class='fg-section-title'>General Information</div>
      ${row('Established in', d.formedState ? `${esc(d.formedState)}${d.formedDate ? ' since ' + d.formedDate : ''}` : '–')}
      ${row('Type', esc(d.firmType || '–'))}
      ${row('Fiscal Year End', esc(d.fiscalYearEnd || '–'))}
      ${d.otherNames?.length ? row('Other names', esc(d.otherNames.join('; '))) : ''}
      ${
				firmId ?
					`
      <div class='fg-section-title fg-section-title--sticky'>Current &amp; Previous Connections</div>
      <a href="/dashboard/firm/${encodeURIComponent(String(firmId))}" class="fg-tl-entry fg-card-clickable" style="display:block;text-decoration:none;text-align:center;margin-top:8px;padding:12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-secondary);">
        <strong>Open Dashboard to view &amp; select connections</strong>
        <span style="display:block;margin-top:4px;font-size:11px;opacity:0.8;">Choose people on the firm page, then Graph to add them here</span>
      </a>
      `
				:	''
			}
    </div>
  `;
}
