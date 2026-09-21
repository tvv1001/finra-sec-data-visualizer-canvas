#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const NATIONAL = path.join(DATA_DIR, 'national');
const SEC_DIR = path.join(NATIONAL, 'adviserinfo.sec.gov');
const FINRA_DIR = path.join(NATIONAL, 'brokercheck.finra.org');
const EXTERNAL_DIR = path.join(DATA_DIR, 'external');

const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)',
	'Accept': 'application/json',
};

function extractIdsFromJson(json) {
	const firms = new Set();
	const inds = new Set();
	try {
		const hits = json?.hits?.hits || [];
		for (const h of hits) {
			const src = h._source || {};
			// common fields
			if (src.firm_id) firms.add(String(src.firm_id));
			if (src.firmId) firms.add(String(src.firmId));
			if (src.firm_bd_sec_number) firms.add(String(src.firm_bd_sec_number));
			if (src.ind_source_id) inds.add(String(src.ind_source_id));
			if (src.person?.crd) inds.add(String(src.person.crd));
			if (src.ind_ia_current_employments) {
				for (const e of src.ind_ia_current_employments) if (e.firmId) firms.add(String(e.firmId));
			}
			if (src.ind_current_employments) {
				for (const e of src.ind_current_employments) if (e.firmId || e.firm_id) firms.add(String(e.firmId || e.firm_id));
			}
			// try parsing content field
			if (src.content) {
				try {
					const parsed = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
					if (parsed?.basicInformation?.individualId) inds.add(String(parsed.basicInformation.individualId));
					if (parsed?.basicInformation?.crd) inds.add(String(parsed.basicInformation.crd));
					if (Array.isArray(parsed?.currentEmployments)) {
						for (const e of parsed.currentEmployments) if (e.firmId) firms.add(String(e.firmId));
					}
				} catch (e) {}
			}
		}
	} catch (e) {}
	return { firms, inds };
}

async function readJsonSafe(file) {
	try {
		const raw = await fs.readFile(file, 'utf-8');
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

async function seedFromExisting() {
	const seenF = new Set();
	const seenI = new Set();
	// scan SEC_DIR and FINRA_DIR
	for (const d of [SEC_DIR, FINRA_DIR]) {
		try {
			const files = await fs.readdir(d);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				const j = await readJsonSafe(path.join(d, f));
				if (!j) continue;
				const { firms, inds } = extractIdsFromJson(j);
				for (const id of firms) seenF.add(id);
				for (const id of inds) seenI.add(id);
			}
		} catch (e) {}
	}
	return { seenF, seenI };
}

async function fetchAndSave(url, outExternal, outNationalPath) {
	try {
		const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
		const raw = JSON.stringify(data, null, 2);
		if (outExternal) {
			await fs.mkdir(EXTERNAL_DIR, { recursive: true });
			await fs.writeFile(path.join(EXTERNAL_DIR, outExternal), raw, 'utf-8');
		}
		if (outNationalPath) {
			await fs.mkdir(path.dirname(outNationalPath), { recursive: true });
			await fs.writeFile(outNationalPath, raw, 'utf-8');
		}
		return data;
	} catch (err) {
		console.error('fetch error', url, err.message);
		return null;
	}
}

function secFirmUrl(id) {
	return `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(id)}&hl=true&nrows=12&start=0&wt=json`;
}
function secIndividualUrl(id) {
	return `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`;
}
function finraFirmUrl(id) {
	return `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&wt=json`;
}
function finraIndividualUrl(id) {
	return `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`;
}

async function crawl(limit = 500, force = false) {
	const { seenF, seenI } = await seedFromExisting();
	const queueF = [];
	const queueI = [];

	// seed queues with what's on disk already parsed
	for (const id of seenF) queueF.push(id);
	for (const id of seenI) queueI.push(id);

	// also scan external dir for any hints
	try {
		const ext = await fs.readdir(EXTERNAL_DIR);
		for (const f of ext) {
			if (!f.endsWith('.json')) continue;
			const j = await readJsonSafe(path.join(EXTERNAL_DIR, f));
			if (!j) continue;
			const { firms, inds } = extractIdsFromJson(j);
			for (const id of firms)
				if (!seenF.has(id)) {
					seenF.add(id);
					queueF.push(id);
				}
			for (const id of inds)
				if (!seenI.has(id)) {
					seenI.add(id);
					queueI.push(id);
				}
		}
	} catch (e) {}

	let fetched = 0;
	while ((queueF.length || queueI.length) && fetched < limit) {
		// prefer individuals first
		let id = null;
		if (queueI.length) id = queueI.shift();
		else id = queueF.shift();

		if (!id) break;
		if (seenI.has(id) && seenF.has(id) && fetched > 0 && fetched >= limit) break;

		// Always try both individual and firm endpoints for numeric IDs
		const numeric = /^\d+$/.test(id);

		// FINRA individual
		if (numeric && (force || !(await exists(path.join(FINRA_DIR, `individual_${id}.json`))))) {
			const url = finraIndividualUrl(id);
			const data = await fetchAndSave(url, `finra_individual_${id}.json`, path.join(FINRA_DIR, `individual_${id}.json`));
			if (data) {
				const { firms, inds } = extractIdsFromJson(data);
				for (const fid of firms)
					if (!seenF.has(fid)) {
						seenF.add(fid);
						queueF.push(fid);
					}
				for (const iid of inds)
					if (!seenI.has(iid)) {
						seenI.add(iid);
						queueI.push(iid);
					}
			}
			fetched++;
			await new Promise((r) => setTimeout(r, 200));
		}
		// SEC individual
		if (numeric && (force || !(await exists(path.join(SEC_DIR, `sec_${id}.json`))))) {
			const url = secIndividualUrl(id);
			const data = await fetchAndSave(url, `sec_individual_${id}.json`, path.join(SEC_DIR, `sec_${id}.json`));
			if (data) {
				const { firms, inds } = extractIdsFromJson(data);
				for (const fid of firms)
					if (!seenF.has(fid)) {
						seenF.add(fid);
						queueF.push(fid);
					}
				for (const iid of inds)
					if (!seenI.has(iid)) {
						seenI.add(iid);
						queueI.push(iid);
					}
			}
			fetched++;
			await new Promise((r) => setTimeout(r, 200));
		}
		// FINRA firm
		if (numeric && (force || !(await exists(path.join(FINRA_DIR, `query_firm_${id}.json`))))) {
			const url = finraFirmUrl(id);
			const data = await fetchAndSave(url, `finra_firm_${id}.json`, path.join(FINRA_DIR, `query_firm_${id}.json`));
			if (data) {
				const { firms, inds } = extractIdsFromJson(data);
				for (const fid of firms)
					if (!seenF.has(fid)) {
						seenF.add(fid);
						queueF.push(fid);
					}
				for (const iid of inds)
					if (!seenI.has(iid)) {
						seenI.add(iid);
						queueI.push(iid);
					}
			}
			fetched++;
			await new Promise((r) => setTimeout(r, 200));
		}
		// SEC firm
		if (numeric && (force || !(await exists(path.join(SEC_DIR, `sec_firm_${id}.json`))))) {
			const url = secFirmUrl(id);
			const data = await fetchAndSave(url, `sec_firm_${id}.json`, path.join(SEC_DIR, `sec_firm_${id}.json`));
			if (data) {
				const { firms, inds } = extractIdsFromJson(data);
				for (const fid of firms)
					if (!seenF.has(fid)) {
						seenF.add(fid);
						queueF.push(fid);
					}
				for (const iid of inds)
					if (!seenI.has(iid)) {
						seenI.add(iid);
						queueI.push(iid);
					}
			}
			fetched++;
			await new Promise((r) => setTimeout(r, 200));
		}

		// For non-numeric IDs, treat as firm id or query string (legacy logic)
		if (!numeric) {
			if (force || !(await exists(path.join(FINRA_DIR, `query_firm_${id}.json`)))) {
				const url = finraFirmUrl(id);
				const data = await fetchAndSave(url, `finra_firm_${id}.json`, path.join(FINRA_DIR, `query_firm_${id}.json`));
				if (data) {
					const { firms, inds } = extractIdsFromJson(data);
					for (const fid of firms)
						if (!seenF.has(fid)) {
							seenF.add(fid);
							queueF.push(fid);
						}
					for (const iid of inds)
						if (!seenI.has(iid)) {
							seenI.add(iid);
							queueI.push(iid);
						}
				}
				fetched++;
				await new Promise((r) => setTimeout(r, 200));
			}
			if (force || !(await exists(path.join(SEC_DIR, `sec_${id}.json`)))) {
				const url = secFirmUrl(id);
				const data = await fetchAndSave(url, `sec_firm_${id}.json`, path.join(SEC_DIR, `sec_${id}.json`));
				if (data) {
					const { firms, inds } = extractIdsFromJson(data);
					for (const fid of firms)
						if (!seenF.has(fid)) {
							seenF.add(fid);
							queueF.push(fid);
						}
					for (const iid of inds)
						if (!seenI.has(iid)) {
							seenI.add(iid);
							queueI.push(iid);
						}
				}
				fetched++;
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	}

	console.log('Crawl complete. fetched=', fetched, 'seenF=', seenF.size, 'seenI=', seenI.size);
}

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

if (require.main === module) {
	const limit = Number(process.argv[2] || 500);
	const force = process.argv.includes('--force') || process.argv.includes('-f');
	if (force) console.log('Force mode: will re-fetch existing files');
	crawl(limit, force).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
