#!/usr/bin/env node
/*
 * fetch_individuals_for_firm.js
 * Usage: FIRM=10111 node scripts/fetch_individuals_for_firm.js
 * or:   node scripts/fetch_individuals_for_firm.js 10111
 *
 * Fetch individual listings for a firm from FINRA BrokerCheck and SEC AdviserInfo
 * and save individual detail payloads to disk under data/national so the local
 * dev server can serve the same cached detail as production.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = process.cwd();

function outPathFor(domainFolder, fileName) {
	return path.join(ROOT, 'data', 'national', domainFolder, fileName);
}

async function mkdirFor(filePath) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function fetchJson(url, opts = {}) {
	console.log('GET', url);
	const res = await fetch(url, opts);
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
	return res.json();
}

function unique(array) {
	return Array.from(new Set(array));
}

async function main() {
	const firm = process.env.FIRM || process.argv[2];
	if (!firm) {
		console.error('Please specify firm id: FIRM=10111 node scripts/fetch_individuals_for_firm.js  OR node scripts/fetch_individuals_for_firm.js 10111');
		process.exit(2);
	}

	const finraSearchUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firm)}&includePrevious=true&hl=true&wt=json`;
	const secSearchUrl = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firm)}&includePrevious=true&wt=json`;

	const fetchOptions = {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'fetch_individuals_for_firm/1.0',
			'Referer': 'https://brokercheck.finra.org/',
		},
	};

	const finraResp = await fetchJson(finraSearchUrl, fetchOptions).catch((e) => {
		console.warn('FINRA search failed:', e.message);
		return null;
	});
	const secResp = await fetchJson(secSearchUrl, { ...fetchOptions, headers: { ...fetchOptions.headers, Referer: 'https://adviserinfo.sec.gov/' } }).catch((e) => {
		console.warn('SEC search failed:', e.message);
		return null;
	});

	const finraIds = [];
	if (finraResp && finraResp.hits && Array.isArray(finraResp.hits.hits)) {
		for (const h of finraResp.hits.hits) {
			const src = h?._source || h; // sometimes raw
			const id = (src?.ind_source_id || src?.ind_crd || src?.crd || src?.individualId || '').toString().trim();
			if (id) finraIds.push(id);
		}
	}

	const secIds = [];
	if (secResp && secResp.hits && Array.isArray(secResp.hits.hits)) {
		for (const h of secResp.hits.hits) {
			const src = h?._source || h;
			const id = (src?.individualId || src?.ind_id || src?.ind_source_id || src?.crd || '').toString().trim();
			if (id) secIds.push(id);
		}
	}

	const allIds = unique([...finraIds, ...secIds]).filter(Boolean);
	console.log('Discovered individual ids:', allIds.length, allIds.slice(0, 20));

	// For each id, fetch the FINRA individual detail and SEC individual detail and write to disk
	for (const id of allIds) {
		try {
			// FINRA individual detail
			const finraUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&wt=json`;
			const finraPayload = await fetchJson(finraUrl, fetchOptions).catch((e) => {
				console.warn('FINRA detail failed for', id, e.message);
				return null;
			});
			if (finraPayload) {
				const fileName = `api.brokercheck.finra.org_search_individual_${id}.json`;
				const filePath = outPathFor('brokercheck.finra.org', fileName);
				await mkdirFor(filePath);
				await fs.writeFile(filePath, JSON.stringify(finraPayload, null, 2), 'utf8');
				console.log('Wrote', filePath);
			}

			// SEC individual detail
			const secUrl = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&wt=json`;
			const secPayload = await fetchJson(secUrl, { ...fetchOptions, headers: { ...fetchOptions.headers, Referer: 'https://adviserinfo.sec.gov/' } }).catch((e) => {
				console.warn('SEC detail failed for', id, e.message);
				return null;
			});
			if (secPayload) {
				const fileName = `api.adviserinfo.sec.gov_search_individual_${id}.json`;
				const filePath = outPathFor('adviserinfo.sec.gov', fileName);
				await mkdirFor(filePath);
				await fs.writeFile(filePath, JSON.stringify(secPayload, null, 2), 'utf8');
				console.log('Wrote', filePath);
			}
		} catch (err) {
			console.warn('Failed for id', id, err.message || err);
		}
	}

	console.log('Done. You may restart your local dev server or run scripts/auto_heal_redis.js with USE_LOCAL_REDIS=1 to validate and persist Redis keys.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
