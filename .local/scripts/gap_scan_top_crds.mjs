#!/usr/bin/env node
/**
 * Probe FINRA/SEC for CRDs missing from local Redis in the top WINDOW numbers
 * below the current high-water marks. Saves hits to Redis + raw disk, updates
 * dashboard:highest-crds zsets.
 *
 *   npx tsx --env-file=.env.local .local/scripts/gap_scan_top_crds.mjs
 *   npx tsx --env-file=.env.local .local/scripts/gap_scan_top_crds.mjs --window=5000 --sleep=300
 *   npx tsx --env-file=.env.local .local/scripts/gap_scan_top_crds.mjs --window=5000 --offset=5000
 *     (offset shifts the window down: scan [max-offset-window+1 .. max-offset])
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import IORedis from 'ioredis';
import {
	hasFirmSourceCoverage,
	hasIndividualSourceCoverage,
} from '../../src/lib/sourceTruth.ts';

const ROOT = process.cwd();
const WINDOW = Number((process.argv.find((a) => a.startsWith('--window=')) || '--window=5000').slice('--window='.length)) || 5000;
const OFFSET = Math.max(0, Number((process.argv.find((a) => a.startsWith('--offset=')) || '--offset=0').slice('--offset='.length)) || 0);
const SLEEP_MS = Number((process.argv.find((a) => a.startsWith('--sleep=')) || '--sleep=300').slice('--sleep='.length)) || 300;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length); // individual|firm|''
const REPORT_PATH = path.join(ROOT, `.local/tmp/gap_scan_offset_${OFFSET}_report.json`);
const LOG_PATH = path.join(ROOT, `.local/tmp/gap_scan_offset_${OFFSET}.log`);

const redis = new IORedis('redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logLine(obj) {
	const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
	console.log(line);
	fsSync.appendFileSync(LOG_PATH, line + '\n');
}

function compressPayload(value) {
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	if (s.length > 512) {
		try {
			return 'br:' + zlib.brotliCompressSync(Buffer.from(s)).toString('base64');
		} catch {
			return s;
		}
	}
	return s;
}

function extractHits(payload) {
	const hits = payload?.hits?.hits;
	return Array.isArray(hits) ? hits : [];
}

function parseEmbedded(source, keys) {
	if (!source || typeof source !== 'object') return null;
	for (const key of keys) {
		const raw = source[key];
		if (raw == null) continue;
		if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object') return parsed;
			} catch {
				return null;
			}
		}
	}
	return null;
}

function detailUrls(kind, crd) {
	if (kind === 'firm') {
		return {
			finra: `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(crd)}?hl=true&wt=json`,
			sec: `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(crd)}?hl=true&wt=json`,
		};
	}
	return {
		finra: `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`,
		sec: `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&wt=json`,
	};
}

function rawDetailPath(host, kind, crd) {
	const dir =
		host === 'finra'
			? path.join(ROOT, 'data/raw/brokercheck.finra.org')
			: path.join(ROOT, 'data/raw/adviserinfo.sec.gov');
	const file =
		host === 'finra'
			? `api.brokercheck.finra.org_search_${kind}_${crd}.json`
			: `api.adviserinfo.sec.gov_search_${kind}_${crd}.json`;
	return path.join(dir, file);
}

async function writeRawDetail(host, kind, crd, envelope) {
	const filePath = rawDetailPath(host, kind, crd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');
	return filePath;
}

async function fetchJson(url) {
	const res = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': 'finra-gap-scan/1.0' },
		redirect: 'follow',
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function summarizeDetail(kind, detail) {
	const basic = detail?.basicInformation || {};
	if (kind === 'firm') {
		return { name: basic.firmName || detail.firmName || '' };
	}
	return {
		name: [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') || basic.name || '',
	};
}

async function headOk(url, acceptPrefix = null) {
	try {
		const res = await fetch(url, {
			method: 'HEAD',
			headers: {
				Accept: '*/*',
				'User-Agent': 'Mozilla/5.0 (compatible; finra-gap-scan/1.0)',
				Referer: 'https://brokercheck.finra.org/',
			},
			redirect: 'follow',
		});
		if (!res.ok) return false;
		if (!acceptPrefix) return true;
		const ctype = String(res.headers.get('content-type') || '').toLowerCase();
		return ctype.startsWith(acceptPrefix) || ctype.includes('pdf') || ctype.includes('octet-stream');
	} catch {
		return false;
	}
}

/**
 * Require a real detail payload (not a search stub) plus evidence of a live registry page:
 * - FINRA firm PDF when available
 * - SEC ADV PDF / hasPdf flag for adviser firms
 * - individuals: embedded detail with in-scope coverage + real name (BrokerCheck PDFs are often blocked)
 */
async function verifyLiveDetailPage(kind, host, crd, detail, summary) {
	if (!summary?.name) return { ok: false, reason: 'missing-name' };
	const covered = kind === 'firm' ? hasFirmSourceCoverage(detail, host) : hasIndividualSourceCoverage(detail, host);
	if (!covered) return { ok: false, reason: 'no-coverage' };
	if (detail?._searchHitOnly) return { ok: false, reason: 'search-hit-only' };

	const basic = detail?.basicInformation || {};
	if (host === 'sec') {
		const hasPdfFlag = String(basic.hasPdf || detail.hasPdf || '').toUpperCase() === 'Y';
		const advUrl = `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(crd)}/PDF/${encodeURIComponent(crd)}.pdf`;
		const advOk = kind === 'firm' ? await headOk(advUrl, 'application/') : false;
		if (kind === 'firm' && (hasPdfFlag || advOk || covered)) {
			return { ok: true, evidence: hasPdfFlag ? 'sec-hasPdf' : advOk ? 'sec-adv-pdf' : 'sec-coverage' };
		}
		if (kind === 'individual' && covered) {
			return { ok: true, evidence: 'sec-individual-coverage' };
		}
		return { ok: false, reason: 'sec-live-page-unverified' };
	}

	// FINRA
	if (kind === 'firm') {
		const pdfUrl = `https://files.brokercheck.finra.org/firm/firm_${encodeURIComponent(crd)}.pdf`;
		const pdfOk = await headOk(pdfUrl, 'application/');
		if (pdfOk) return { ok: true, evidence: 'finra-firm-pdf' };
		// Some firms are IA-only on SEC; if FINRA content exists with coverage keep it.
		if (covered) return { ok: true, evidence: 'finra-firm-coverage' };
		return { ok: false, reason: 'finra-firm-pdf-missing' };
	}

	// Individuals: require coverage + name; PDF endpoint is frequently 403 from datacenter IPs.
	if (covered) return { ok: true, evidence: 'finra-individual-coverage' };
	return { ok: false, reason: 'finra-individual-unverified' };
}

async function alreadyHave(kind, crd) {
	const keys = [`finra:${kind}:${crd}`, `sec:${kind}:${crd}`];
	const counts = await Promise.all(keys.map((k) => redis.exists(k)));
	return counts.some((n) => Number(n) > 0);
}

async function saveCrd(kind, crd) {
	if (await alreadyHave(kind, crd)) {
		await redis.zadd(`dashboard:highest-crds:${kind}`, Number(crd), String(crd));
		return { status: 'exists', kind, crd };
	}
	const urls = detailUrls(kind, crd);
	const written = [];
	const skipped = [];
	for (const host of ['finra', 'sec']) {
		let envelope;
		try {
			envelope = await fetchJson(urls[host]);
		} catch (e) {
			skipped.push({ host, reason: e.message });
			await sleep(SLEEP_MS);
			continue;
		}
		await sleep(SLEEP_MS);
		const total = envelope?.hits?.total;
		const totalVal = typeof total === 'number' ? total : total?.value;
		if (!totalVal || !extractHits(envelope).length) {
			skipped.push({ host, reason: 'empty' });
			continue;
		}
		const hit = extractHits(envelope)[0];
		const source = hit?._source || {};
		const detail =
			host === 'finra' ? parseEmbedded(source, ['content', 'iacontent']) : parseEmbedded(source, ['iacontent', 'content']);
		if (!detail) {
			skipped.push({ host, reason: 'no-embedded-detail' });
			continue;
		}
		const summary = summarizeDetail(kind, detail);
		const live = await verifyLiveDetailPage(kind, host, crd, detail, summary);
		if (!live.ok) {
			skipped.push({ host, reason: live.reason, ...summary });
			continue;
		}
		const key = `${host}:${kind}:${crd}`;
		await redis.set(key, compressPayload(JSON.stringify(envelope)));
		const rawPath = await writeRawDetail(host, kind, crd, envelope);
		written.push({ key, rawPath, evidence: live.evidence, ...summary });
	}
	if (!written.length) return { status: 'no-live-detail', kind, crd, skipped };
	await redis.zadd(`dashboard:highest-crds:${kind}`, Number(crd), String(crd));
	return { status: 'saved', kind, crd, written, skipped };
}

async function listMissingInWindow(kind, max, window) {
	const missing = [];
	const min = Math.max(1, max - window + 1);
	for (let start = min; start <= max; start += 500) {
		const end = Math.min(max, start + 499);
		const pipe = redis.pipeline();
		const ids = [];
		for (let crd = start; crd <= end; crd++) {
			ids.push(crd);
			pipe.exists(`finra:${kind}:${crd}`);
			pipe.exists(`sec:${kind}:${crd}`);
		}
		const res = await pipe.exec();
		for (let i = 0; i < ids.length; i++) {
			const finra = Number(res[i * 2][1] || 0) > 0;
			const sec = Number(res[i * 2 + 1][1] || 0) > 0;
			if (!finra && !sec) missing.push(ids[i]);
		}
	}
	return missing;
}

async function probeExistsExternally(kind, crd) {
	const urls = detailUrls(kind, crd);
	let any = false;
	const hosts = {};
	for (const host of ['finra', 'sec']) {
		try {
			const envelope = await fetchJson(urls[host]);
			const total = envelope?.hits?.total;
			const totalVal = typeof total === 'number' ? total : total?.value;
			const hits = extractHits(envelope);
			const source = hits[0]?._source || {};
			const detail =
				host === 'finra' ? parseEmbedded(source, ['content', 'iacontent']) : parseEmbedded(source, ['iacontent', 'content']);
			const summary = summarizeDetail(kind, detail || {});
			const hasDetail = Boolean(detail && summary.name);
			hosts[host] = { total: totalVal || 0, hits: hits.length, hasDetail, name: summary.name || null };
			// Only count as a candidate when embedded detail + name exist (not empty search shells).
			if (totalVal > 0 && hits.length > 0 && hasDetail) any = true;
		} catch (e) {
			hosts[host] = { error: e.message };
		}
		await sleep(SLEEP_MS);
	}
	return { any, hosts };
}

async function main() {
	await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
	fsSync.writeFileSync(LOG_PATH, '');

	const indTop = Number((await redis.zrevrange('dashboard:highest-crds:individual', 0, 0))[0] || 0);
	const firmTop = Number((await redis.zrevrange('dashboard:highest-crds:firm', 0, 0))[0] || 0);
	const maxInd = Math.max(1, Math.max(indTop, 8323100) - OFFSET);
	const maxFirm = Math.max(1, Math.max(firmTop, 343953) - OFFSET);

	const report = {
		startedAt: new Date().toISOString(),
		window: WINDOW,
		offset: OFFSET,
		sleepMs: SLEEP_MS,
		maxInd,
		maxFirm,
		rangeInd: { min: Math.max(1, maxInd - WINDOW + 1), max: maxInd },
		rangeFirm: { min: Math.max(1, maxFirm - WINDOW + 1), max: maxFirm },
		saved: [],
		existsAlready: [],
		externalEmpty: 0,
		errors: [],
	};

	logLine({ phase: 'start', window: WINDOW, offset: OFFSET, maxInd, maxFirm, only: ONLY || 'both', rangeInd: report.rangeInd, rangeFirm: report.rangeFirm });

	// Always try to ingest the known new firm first.
	if (!ONLY || ONLY === 'firm') {
		const firmSave = await saveCrd('firm', 343853);
		logLine({ phase: 'seed-firm', ...firmSave, name: firmSave.written?.[0]?.name });
		if (firmSave.status === 'saved') report.saved.push(firmSave);
		else if (firmSave.status === 'exists') report.existsAlready.push({ kind: 'firm', crd: 343853 });
	}

	const jobs = [];
	if (!ONLY || ONLY === 'individual') jobs.push({ kind: 'individual', max: maxInd });
	if (!ONLY || ONLY === 'firm') jobs.push({ kind: 'firm', max: maxFirm });

	for (const job of jobs) {
		const missing = await listMissingInWindow(job.kind, job.max, WINDOW);
		logLine({ phase: 'missing-listed', kind: job.kind, missing: missing.length, max: job.max, min: Math.max(1, job.max - WINDOW + 1) });

		let i = 0;
		for (const crd of missing) {
			i += 1;
			if (i % 50 === 0 || i === 1) {
				logLine({ phase: 'progress', kind: job.kind, i, of: missing.length, crd, saved: report.saved.length });
			}
			try {
				const probe = await probeExistsExternally(job.kind, crd);
				if (!probe.any) {
					report.externalEmpty += 1;
					continue;
				}
				const saved = await saveCrd(job.kind, crd);
				if (saved.status === 'saved') {
					report.saved.push(saved);
					logLine({
						phase: 'saved',
						kind: job.kind,
						crd,
						name: saved.written?.[0]?.name,
						keys: saved.written?.map((w) => w.key),
					});
				} else if (saved.status === 'exists') {
					report.existsAlready.push({ kind: job.kind, crd });
				} else {
					logLine({ phase: 'external-hit-no-save', kind: job.kind, crd, saved });
				}
			} catch (e) {
				report.errors.push({ kind: job.kind, crd, error: e.message });
				logLine({ phase: 'error', kind: job.kind, crd, error: e.message });
			}
		}
	}

	// Keep zsets bounded
	await redis.zremrangebyrank('dashboard:highest-crds:individual', 0, -501);
	await redis.del('dashboard:new-crds-cache');

	report.finishedAt = new Date().toISOString();
	report.savedCount = report.saved.length;
	report.savedSummary = report.saved.map((s) => ({
		kind: s.kind,
		crd: s.crd,
		name: s.written?.[0]?.name,
		keys: s.written?.map((w) => w.key),
	}));

	await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
	logLine({ phase: 'done', savedCount: report.savedCount, externalEmpty: report.externalEmpty, errors: report.errors.length, report: REPORT_PATH });
	await redis.quit();
}

main().catch(async (e) => {
	console.error(e);
	try {
		await redis.quit();
	} catch {}
	process.exit(1);
});
