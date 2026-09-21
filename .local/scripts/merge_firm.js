#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Accept firm id as first argument, default to 10111 for backwards compatibility
const id = String(process.argv[2] || process.env.CRD || '10111').trim();
if (!/^\d{1,10}$/.test(id)) {
	console.error('Invalid firm id:', id);
	process.exit(2);
}

function safeParseContent(obj, key) {
	if (!obj) return null;
	const raw = obj[key];
	if (!raw) return null;
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		} catch (e) {
			return null;
		}
	}
	if (typeof raw === 'object') return raw;
	return null;
}

function normalizeSecFirmId(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (/^8-\d+$/i.test(raw)) return raw;
	if (/^\d+$/.test(raw)) return `8-${raw}`;
	return raw;
}

async function fetchJson(url) {
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

async function main() {
	const bcUrl = `https://api.brokercheck.finra.org/search/firm/${id}?hl=true&wt=json`;
	const secUrl = `https://api.adviserinfo.sec.gov/search/firm/${id}?wt=json`;
	console.log('Fetching', bcUrl);
	const bc = await fetchJson(bcUrl).catch((e) => {
		console.error('bc fetch failed', e.message);
		return null;
	});
	console.log('Fetching', secUrl);
	const sec = await fetchJson(secUrl).catch((e) => {
		console.error('sec fetch failed', e.message);
		return null;
	});

	const outDirBc = path.join(process.cwd(), 'data', 'national', 'brokercheck.finra.org');
	const outDirSec = path.join(process.cwd(), 'data', 'national', 'adviserinfo.sec.gov');
	fs.mkdirSync(outDirBc, { recursive: true });
	fs.mkdirSync(outDirSec, { recursive: true });
	if (bc) fs.writeFileSync(path.join(outDirBc, `api.brokercheck.finra.org_search_firm_${id}.json`), JSON.stringify(bc, null, 2), 'utf8');
	if (sec) fs.writeFileSync(path.join(outDirSec, `api.adviserinfo.sec.gov_search_firm_${id}.json`), JSON.stringify(sec, null, 2), 'utf8');

	const bcDetail = bc ? safeParseContent(bc.hits && bc.hits.hits && bc.hits.hits[0] && bc.hits.hits[0]._source ? bc.hits.hits[0]._source : bc, 'content') : null;
	const secDetail = sec ? safeParseContent(sec.hits && sec.hits.hits && sec.hits.hits[0] && sec.hits.hits[0]._source ? sec.hits.hits[0]._source : sec, 'iacontent') : null;

	let detail = bcDetail || secDetail || {};
	if (secDetail) {
		const sbi = secDetail.basicInformation || {};
		const dbi = detail.basicInformation || {};
		const mergeField = (key) => {
			if (!dbi[key] && sbi[key]) dbi[key] = sbi[key];
		};
		[
			'firmStatus',
			'firmStatusDate',
			'firmType',
			'firmSize',
			'regulator',
			'formedState',
			'formedDate',
			'districtName',
			'isLegacy',
			'iaSECNumber',
			'bdSECNumber',
			'bcScope',
			'iaScope',
			'fiscalMonthEndCode',
		].forEach(mergeField);
		if ((!dbi.otherNames || !dbi.otherNames.length) && sbi.otherNames?.length) dbi.otherNames = sbi.otherNames;
		detail.basicInformation = dbi;
		if (!detail.firmAddressDetails && secDetail.firmAddressDetails) detail.firmAddressDetails = secDetail.firmAddressDetails;
		if (!detail.iaFirmAddressDetails && secDetail.iaFirmAddressDetails) detail.iaFirmAddressDetails = secDetail.iaFirmAddressDetails;
		if (!detail.registrations && secDetail.registrations) detail.registrations = secDetail.registrations;
		if (!detail.registrationStatus && secDetail.registrationStatus) detail.registrationStatus = secDetail.registrationStatus;
		if (!detail.noticeFilings && secDetail.noticeFilings) detail.noticeFilings = secDetail.noticeFilings;
		if (!detail.directOwners?.length && secDetail.directOwners?.length) detail.directOwners = secDetail.directOwners;
		if (!detail.disclosures?.length && secDetail.disclosures?.length) detail.disclosures = secDetail.disclosures;
		if (!detail.brochures && secDetail.brochures) detail.brochures = secDetail.brochures;
	}

	const secFirmId = normalizeSecFirmId(detail?.basicInformation?.bdSECNumber || detail?.basicInformation?.bdSecNumber || detail?.bdSECNumber || detail?.bdSecNumber || id);
	if (secFirmId && (!detail.secDocumentLinks || !detail.secDocumentLinks.length)) {
		detail.secDocumentLinks = [
			{ label: 'SEC AdvisorInfo Summary', href: `https://adviserinfo.sec.gov/firm/summary/${secFirmId}` },
			{ label: 'Latest Form ADV filed', href: `https://reports.adviserinfo.sec.gov/reports/ADV/${secFirmId}/PDF/${secFirmId}.pdf` },
			{ label: 'SEC firm brochure', href: `https://adviserinfo.sec.gov/firm/brochure/${secFirmId}` },
			{ label: 'SEC Form CRS', href: `https://reports.adviserinfo.sec.gov/crs/crs_${secFirmId}.pdf` },
		];
	}

	const mergedDir = path.join(process.cwd(), 'data', 'national');
	fs.mkdirSync(mergedDir, { recursive: true });
	fs.writeFileSync(
		path.join(mergedDir, `finra-firm-${id}.json`),
		JSON.stringify({ firmId: id, found: true, merged: detail, sources: { finra: bcDetail, sec: secDetail } }, null, 2),
		'utf8',
	);

	console.log('Wrote merged file to data/national/finra-firm-' + id + '.json');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
