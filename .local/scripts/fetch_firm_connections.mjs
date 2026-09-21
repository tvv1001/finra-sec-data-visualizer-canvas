import fs from 'fs';
import path from 'path';
// import fetch from 'node-fetch'; // Removed node-fetch import

function toArraySafe(v) {
	return Array.isArray(v) ? v : [];
}
function firstNonEmpty(...vals) {
	for (const v of vals) {
		const t = String(v ?? '').trim();
		if (t) return t;
	}
	return '';
}

function mapHitsToEntries(hits) {
	const out = [];
	for (const hit of hits) {
		const src = hit?._source || hit || {};
		const crd = firstNonEmpty(src.ind_source_id, src.ind_crd, src.individualId, src.id);
		if (!crd) continue;
		const name = firstNonEmpty([src.ind_firstname, src.ind_middlename, src.ind_lastname].filter(Boolean).join(' '), src.individualName, src.name);
		const currentEmployments = [...toArraySafe(src.ind_current_employments), ...toArraySafe(src.currentEmployments), ...toArraySafe(src.currentIAEmployments)];
		const previousEmployments = [
			...toArraySafe(src.ind_previous_employments),
			...toArraySafe(src.ind_ia_previous_employments),
			...toArraySafe(src.previousEmployments),
			...toArraySafe(src.previousIAEmployments),
		];

		const matchedCurrent = currentEmployments.find((e) => firstNonEmpty(e?.firmId, e?.firm_id) === process.argv[2]);
		if (matchedCurrent) {
			out.push({
				individualId: crd,
				name,
				relationship: 'Current registration',
				startDate: firstNonEmpty(matchedCurrent?.registrationBeginDate, matchedCurrent?.startDate) || undefined,
				endDate: undefined,
				isCurrent: true,
			});
			continue;
		}
		const matchedPrevious = previousEmployments.find((e) => firstNonEmpty(e?.firmId, e?.firm_id) === process.argv[2]);
		if (matchedPrevious) {
			out.push({
				individualId: crd,
				name,
				relationship: 'Previous registration',
				startDate: firstNonEmpty(matchedPrevious?.registrationBeginDate, matchedPrevious?.startDate) || undefined,
				endDate: firstNonEmpty(matchedPrevious?.registrationEndDate, matchedPrevious?.endDate) || undefined,
				isCurrent: false,
			});
			continue;
		}
		// fallback
		out.push({ individualId: crd, name, relationship: 'Previous registration', startDate: undefined, endDate: undefined, isCurrent: false });
	}
	return out;
}

async function fetchUrl(url) {
	try {
		const res = await global.fetch(url, { cache: 'no-store' }); // Use global fetch
		if (!res.ok) return [];
		const data = await res.json();
		if (data?.hits?.hits) return data.hits.hits;
		return [];
	} catch (e) {
		return [];
	}
}

async function main() {
	const firmId = process.argv[2];
	if (!firmId) {
		console.error('usage: node scripts/fetch_firm_connections.mjs 107342');
		process.exit(2);
	}
	const maxRows = 100;
	const finraUrl = `https://api.brokercheck.finra.org/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxRows}&includePrevious`;
	const secUrl = `https://api.adviserinfo.sec.gov/search/individual?firm=${encodeURIComponent(firmId)}&hl=true&wt=json&nrows=${maxRows}&includePrevious`;

	console.log('fetching finra...');
	const finraHits = await fetchUrl(finraUrl);
	console.log('finra hits', finraHits.length);
	console.log('fetching sec...');
	const secHits = await fetchUrl(secUrl);
	console.log('sec hits', secHits.length);

	const mergedHits = [...finraHits, ...secHits];
	const entries = mapHitsToEntries(mergedHits);

	// dedupe by individualId:isCurrent
	const seen = new Set();
	const current = [];
	const previous = [];
	for (const e of entries) {
		const key = `${e.individualId}:${e.isCurrent}`;
		if (seen.has(key)) continue;
		seen.add(key);
		(e.isCurrent ? current : previous).push(e);
	}

	const out = { currentConnections: current, previousConnections: previous };
	const dir = path.join(process.cwd(), 'data', 'firm-connections');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${firmId}.json`);
	fs.writeFileSync(file, JSON.stringify(out, null, 2));
	console.log('wrote', file, 'current', current.length, 'previous', previous.length);
}

main();
