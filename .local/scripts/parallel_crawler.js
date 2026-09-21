#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const NATIONAL = path.join(DATA_DIR, 'national');
const EXTERNAL = path.join(DATA_DIR, 'external');
const FINRA = path.join(NATIONAL, 'brokercheck.finra.org');
const SEC = path.join(NATIONAL, 'adviserinfo.sec.gov');
const GRAPH_FILE = path.join(NATIONAL, 'finra-graph.json');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'application/json' };

async function fetchWithScrapy(url) {
	const SCRAPY = path.join(ROOT, 'scripts', 'scrapy.py');
	console.log('[parallel_crawler] Falling back to scrapy.py for:', url);
	try {
		const result = spawnSync('python3', [SCRAPY, url], { encoding: 'utf-8' });
		if (result.status !== 0) {
			console.warn('[parallel_crawler] scrapy.py process failed:', result.stderr);
			return { ok: false };
		}
		const payload = JSON.parse(result.stdout);
		if (!payload.ok) {
			console.warn('[parallel_crawler] scrapy.py reported error:', payload.error);
			return { ok: false, status: payload.status };
		}
		// Try to parse people payload if it's there
		if (payload.peoplePayload) {
			try {
				return { ok: true, data: JSON.parse(payload.peoplePayload) };
			} catch (e) {
				return { ok: true, data: payload.html };
			}
		}
		return { ok: true, data: payload.html };
	} catch (e) {
		console.warn('[parallel_crawler] scrapy.py execution failed:', e.message);
		return { ok: false };
	}
}

function finraFirmUrl(id) {
	return `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&wt=json`;
}
function finraIndividualUrl(id) {
	return `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`;
}
function secFirmUrl(id) {
	return `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`;
}
function secIndividualUrl(id) {
	return `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`;
}

async function readJsonSafe(file) {
	try {
		return JSON.parse(await fs.readFile(file, 'utf-8'));
	} catch {
		return null;
	}
}

function extractIds(json) {
	const firms = new Set();
	const inds = new Set();
	try {
		const hits = json?.hits?.hits || [];
		for (const h of hits) {
			const src = h._source || {};
			if (src.firm_id) firms.add(String(src.firm_id));
			if (src.firmId) firms.add(String(src.firmId));
			if (src.firm_bd_sec_number) firms.add(String(src.firm_bd_sec_number));
			if (src.ind_source_id) inds.add(String(src.ind_source_id));
			if (src.person?.crd) inds.add(String(src.person.crd));
			if (Array.isArray(src.ind_current_employments)) for (const e of src.ind_current_employments) if (e.firmId) firms.add(String(e.firmId));
			if (Array.isArray(src.ind_ia_current_employments)) for (const e of src.ind_ia_current_employments) if (e.firmId) firms.add(String(e.firmId));
			if (src.content) {
				try {
					const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
					if (c?.basicInformation?.individualId) inds.add(String(c.basicInformation.individualId));
					if (c?.basicInformation?.crd) inds.add(String(c.basicInformation.crd));
					if (Array.isArray(c?.currentEmployments)) for (const e of c.currentEmployments) if (e.firmId) firms.add(String(e.firmId));
				} catch {}
			}
		}
	} catch {}
	return { firms, inds };
}

async function gatherSeedIds() {
	const firms = new Set();
	const inds = new Set();
	const dirs = [FINRA, SEC, EXTERNAL];
	for (const d of dirs) {
		try {
			const files = await fs.readdir(d);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				const j = await readJsonSafe(path.join(d, f));
				if (!j) continue;
				const { firms: fset, inds: iset } = extractIds(j);
				for (const id of fset) firms.add(id);
				for (const id of iset) inds.add(id);
			}
		} catch {}
	}

	try {
		const graph = await readJsonSafe(GRAPH_FILE);
		const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
		for (const node of nodes) {
			const nodeId = String(node?.id || '').trim();
			if (node?.group === 'individual' && nodeId.startsWith('person:')) inds.add(nodeId.slice('person:'.length));
			else if (node?.group === 'firm' && nodeId.startsWith('firm:')) firms.add(nodeId.slice('firm:'.length));
			else if (nodeId.startsWith('person:')) inds.add(nodeId.slice('person:'.length));
			else if (nodeId.startsWith('firm:')) firms.add(nodeId.slice('firm:'.length));
		}
	} catch {}

	return { firms, inds };
}

async function exists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchAndWrite(url, externalName, nationalPath) {
	try {
		const r = await axios.get(url, { headers: HEADERS, timeout: 25000 });
		const txt = JSON.stringify(r.data, null, 2);
		if (externalName) {
			await fs.mkdir(EXTERNAL, { recursive: true });
			await fs.writeFile(path.join(EXTERNAL, externalName), txt, 'utf-8');
		}
		if (nationalPath) {
			await fs.mkdir(path.dirname(nationalPath), { recursive: true });
			await fs.writeFile(nationalPath, txt, 'utf-8');
		}
		return { ok: true };
	} catch (e) {
		const status = e?.response?.status;
		const retryAfterHeader = e?.response?.headers?.['retry-after'];
		const retryAfter = Number.isFinite(Number(retryAfterHeader)) && Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : null;

		if (status === 429 || status === 403 || status === 401) {
			console.warn(`fetch blocked (${status})`, url);
			// Try scrapy fallback
			const res = await fetchWithScrapy(url);
			if (res.ok && res.data) {
				const txt = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
				if (externalName) {
					await fs.mkdir(EXTERNAL, { recursive: true });
					await fs.writeFile(path.join(EXTERNAL, externalName), txt, 'utf-8');
				}
				if (nationalPath) {
					await fs.mkdir(path.dirname(nationalPath), { recursive: true });
					await fs.writeFile(nationalPath, txt, 'utf-8');
				}
				return { ok: true };
			}
			return { ok: false, status, retryAfter };
		}
		console.warn('fetch failed', url, e.message);
		return { ok: false, status };
	}
}

function randBetween(min, max) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

async function parallelFetch(tasks, concurrency = 1, delayMs = 4000, maxRetries = 4) {
	let fetched = 0;
	const failed = [];
	let upstreamCooldownUntil = 0;

	// Strictly sequential if concurrency is 1
	if (concurrency === 1) {
		for (let i = 0; i < tasks.length; i++) {
			const t = tasks[i];
			let attempt = 0;
			let success = false;

			while (attempt <= maxRetries && !success) {
				attempt++;
				
				const now = Date.now();
				if (now < upstreamCooldownUntil) {
					const waitMs = upstreamCooldownUntil - now;
					console.log(`[parallel_crawler] Sequential pause for 429 cooldown: ${(waitMs / 60000).toFixed(2)} minutes remaining...`);
					await sleep(waitMs);
				}

				// Exponential backoff base using delayMs
				const baseDelay = attempt > 1 ? Math.min(30000, delayMs * Math.pow(2, attempt - 2)) : delayMs;
				// Apply jitter to backoff (0.6x to 1.4x)
				const jitteredDelay = randBetween(Math.round(baseDelay * 0.6), Math.round(baseDelay * 1.4));
				await sleep(jitteredDelay);

				const res = await fetchAndWrite(t.url, t.external, t.national);
				if (res.ok) {
					success = true;
					fetched++;
					break;
				}

				if (res.status === 429 || res.status === 403) {
					// 2-4 minutes cooldown like the reference app
					const cooldownMs = res.retryAfter || randBetween(2 * 60 * 1000, 4 * 60 * 1000); 
					upstreamCooldownUntil = Date.now() + cooldownMs;
					console.warn(`[parallel_crawler] 429/403 Hit. Pausing for ${(cooldownMs / 60000).toFixed(2)} minutes.`);
					await sleep(cooldownMs);
					continue;
				}
			}

			if (!success) failed.push(t);
		}
	} else {
		// Parallel logic with same 429 awareness
		let idx = 0;

		async function worker(id) {
			while (true) {
				const i = idx++;
				if (i >= tasks.length) break;
				const t = tasks[i];
				let attempt = 0;
				let success = false;
				while (attempt <= maxRetries && !success) {
					attempt++;

					const now = Date.now();
					if (now < upstreamCooldownUntil) {
						await sleep(upstreamCooldownUntil - now);
					}

					// Exponential backoff base using delayMs
					const baseDelay = attempt > 1 ? Math.min(30000, delayMs * Math.pow(2, attempt - 2)) : delayMs;
					// Apply jitter to backoff (0.6x to 1.4x)
					const jitteredDelay = randBetween(Math.round(baseDelay * 0.6), Math.round(baseDelay * 1.4));
					await sleep(jitteredDelay);

					const res = await fetchAndWrite(t.url, t.external, t.national);
					if (res.ok) {
						success = true;
						fetched++;
						break;
					}
					if (res.status === 429 || res.status === 403) {
						const cooldownMs = res.retryAfter || randBetween(2 * 60 * 1000, 4 * 60 * 1000);
						upstreamCooldownUntil = Date.now() + cooldownMs;
						console.warn(`Worker ${id}: 429/403 => sleeping ${(cooldownMs / 60000).toFixed(2)}m`);
						await sleep(cooldownMs);
						continue;
					}
				}
				if (!success) failed.push(t);
			}
		}

		const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, (_, i) => worker(i + 1));
		await Promise.all(workers);
	}

	if (failed.length) console.warn('Some tasks still failed after retries:', failed.length);
	return fetched;
}

async function validateLocalData() {
	const report = { total: 0, parsed: 0, errors: [] };
	const folders = [EXTERNAL, FINRA, SEC];
	for (const folder of folders) {
		try {
			const files = await fs.readdir(folder);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				const p = path.join(folder, f);
				report.total++;
				try {
					const txt = await fs.readFile(p, 'utf-8');
					if (!txt || !txt.trim()) throw new Error('empty file');
					JSON.parse(txt);
					report.parsed++;
				} catch (e) {
					report.errors.push({ file: p, error: String(e.message || e) });
				}
			}
		} catch (e) {
			// ignore missing folders
		}
	}
	// write report
	try {
		await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
		await fs.writeFile(path.join(ROOT, 'data', 'last_crawl_report.json'), JSON.stringify(report, null, 2), 'utf-8');
	} catch {}
	return report;
}

async function main() {
	const argv = require('minimist')(process.argv.slice(2));
	const concurrency = Number(argv.concurrency || argv.c || 1); // Default to sequential
	const force = argv.force || argv.f || false;
	const limit = Number(argv.limit || 100); // Steady small batches

	const { firms, inds } = await gatherSeedIds();
	// augment with seed-profiles individuals as extra
	try {
		const seedFile = path.join(ROOT, 'data', 'seed-profiles.json');
		const seeds = JSON.parse(await fs.readFile(seedFile, 'utf-8'));
		if (Array.isArray(seeds.profiles)) {
			const prof = seeds.profiles.find((p) => p.name === 'custom');
			if (prof && Array.isArray(prof.individuals)) {
				for (const id of prof.individuals) inds.add(String(id));
			}
		}
	} catch {}

	const tasks = [];
	for (const id of firms) {
		if (tasks.length >= limit) break;
		const numeric = /^\d+$/.test(id);
		const finraFile = `api.brokercheck.finra.org_search_firm_${id}.json`;
		const secFile = `api.adviserinfo.sec.gov_search_firm_${id}.json`;
		const finraPath = path.join(FINRA, finraFile);
		const secPath = path.join(SEC, secFile);
		if (numeric && (force || !(await exists(finraPath)))) tasks.push({ url: finraFirmUrl(id), external: finraFile, national: finraPath });
		if (numeric && (force || !(await exists(secPath)))) tasks.push({ url: secFirmUrl(id), external: secFile, national: secPath });
	}
	for (const id of inds) {
		if (tasks.length >= limit) break;
		const numeric = /^\d+$/.test(id);
		if (numeric) {
			const finraFile = `api.brokercheck.finra.org_search_individual_${id}.json`;
			const secFile = `api.adviserinfo.sec.gov_search_individual_${id}.json`;
			const finraPath = path.join(FINRA, finraFile);
			const secPath = path.join(SEC, secFile);
			if (force || !(await exists(finraPath))) tasks.push({ url: finraIndividualUrl(id), external: finraFile, national: finraPath });
			if (force || !(await exists(secPath))) tasks.push({ url: secIndividualUrl(id), external: secFile, national: secPath });
		}
	}

	console.log('Prepared', tasks.length, 'tasks; running with concurrency=', concurrency);
	const delay = Number(argv.delay || argv.d || 4000); // 4s steady delay
	const fetched = await parallelFetch(tasks, concurrency, delay);
	console.log('Parallel crawl complete. fetched=', fetched);
	console.log('Validating local JSON files...');
	const report = await validateLocalData();
	console.log('Validation summary:', report.total, 'files, parsed=', report.parsed, 'errors=', report.errors.length);
	if (report.errors.length) console.log('Sample error:', report.errors[0]);
}

if (require.main === module)
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
