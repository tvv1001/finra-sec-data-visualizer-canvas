#!/usr/bin/env node
/**
 * daily_status_check.js
 *
 * Runs a status integrity check for the local graph data.
 *
 * For every node in the local graph that has a CRD, this script:
 *  1. Determines its source truth: FINRA=boolean · SEC=boolean
 *  2. Fetches the live upstream record(s) from FINRA BrokerCheck and/or
 *     SEC AdviserInfo
 *  3. Compares live status fields (bcScope, iaScope, firmStatus, bcStatus)
 *     against the cached value stored in the local graph
 *  4. Flags nodes that are inactive/terminated upstream but rendered as
 *     active locally
 *  5. Writes a JSON report to data/last_status_check_report.json
 *
 * Run manually:
 *   node scripts/daily_status_check.js
 *   node scripts/daily_status_check.js --concurrency=4 --delay=300
 *
 * Flags:
 *   --concurrency=N   parallel API requests (default 3)
 *   --delay=Ms        ms to wait between batches (default 400)
 *   --dry-run         print report but do not write file
 *   --crd=<id>        only check a single CRD (individual or firm)
 */

'use strict';

const fs = require('fs/promises');
const path = require('path');
const https = require('https');

const ROOT = process.cwd();
const NATIONAL = path.join(ROOT, 'data', 'national');
const GRAPH_FILE = path.join(NATIONAL, 'finra-graph.json');
const REPORT_FILE = path.join(ROOT, 'data', 'last_status_check_report.json');

const argv = (() => {
	const out = { concurrency: 3, delay: 400, dryRun: false, singleCrd: null };
	for (const arg of process.argv.slice(2)) {
		const [k, v] = arg.replace(/^--/, '').split('=');
		if (k === 'concurrency') out.concurrency = Math.max(1, Number(v) || 3);
		else if (k === 'delay') out.delay = Math.max(0, Number(v) || 400);
		else if (k === 'dry-run') out.dryRun = true;
		else if (k === 'crd') out.singleCrd = String(v || '').trim();
	}
	return out;
})();

const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)',
	'Accept': 'application/json',
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function fetchJson(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: HEADERS }, (res) => {
			let body = '';
			res.on('data', (d) => (body += d));
			res.on('end', () => {
				if (res.statusCode === 404) {
					resolve(null);
					return;
				}
				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode} for ${url}`));
					return;
				}
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(new Error(`JSON parse error for ${url}: ${e.message}`));
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(15000, () => {
			req.destroy(new Error(`Timeout: ${url}`));
		});
	});
}

// ─── API URL builders (no nrows — matches normalised cache key) ───────────────

function finraIndividualUrl(crd) {
	return `https://api.brokercheck.finra.org/search/individual/${crd}?hl=true&includePrevious=true&wt=json`;
}
function finraFirmUrl(crd) {
	return `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`;
}
function secIndividualUrl(crd) {
	return `https://api.adviserinfo.sec.gov/search/individual/${crd}?wt=json`;
}
function secFirmUrl(crd) {
	return `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
}

// ─── Status classification (mirrors finra-graph.ts helpers) ──────────────────

const INACTIVE_TERMS = ['inactive', 'terminated', 'revoked', 'withdrawn', 'suspended', 'barred', 'expelled'];
const ACTIVE_TERMS = ['active', 'approved', 'registered'];
const NOT_IN_SCOPE = ['not_in_scope', 'not in scope', 'n/a', 'na', '', null, undefined];

function classifyText(value) {
	const v = String(value || '')
		.toLowerCase()
		.trim();
	if (NOT_IN_SCOPE.includes(v)) return 'not_in_scope';
	if (INACTIVE_TERMS.some((t) => v.includes(t))) return 'inactive';
	if (ACTIVE_TERMS.some((t) => v.includes(t))) return 'active';
	return 'unknown';
}

function collectFlags(values) {
	let hasActive = false;
	let hasInactive = false;
	for (const v of values) {
		const cls = classifyText(v);
		if (cls === 'active') hasActive = true;
		if (cls === 'inactive') hasInactive = true;
	}
	return { hasActive, hasInactive };
}

// ─── Source-truth helpers ─────────────────────────────────────────────────────

/**
 * Determine whether the live upstream response has FINRA presence.
 * For individuals: bcScope ACTIVE or INACTIVE (not not-in-scope).
 * For firms: bcScope present + not not-in-scope.
 */
function liveFinraPresence(bi) {
	if (!bi) return false;
	const cls = classifyText(bi.bcScope);
	return cls === 'active' || cls === 'inactive';
}

/**
 * Determine whether the live upstream response has SEC IA presence.
 */
function liveSecPresence(bi) {
	if (!bi) return false;
	// SEC number is the strongest signal
	if (bi.iaSECNumber || bi.iaSecNumber) return true;
	const iaClass = classifyText(bi.iaScope);
	const fsClass = classifyText(bi.firmStatus ?? bi.bcStatus);
	return iaClass === 'active' || iaClass === 'inactive' || fsClass === 'active' || fsClass === 'inactive';
}

// ─── Parse upstream hit into a flat status object ─────────────────────────────

function parseFirmHit(hit) {
	if (!hit) return null;
	const src = hit._source ?? {};
	let bi = {};
	if (src.content)
		try {
			bi = JSON.parse(src.content).basicInformation ?? {};
		} catch {}
	if (src.iacontent)
		try {
			bi = JSON.parse(src.iacontent).basicInformation ?? {};
		} catch {}
	if (src.bccontent)
		try {
			bi = JSON.parse(src.bccontent).basicInformation ?? {};
		} catch {}
	return {
		bcScope: bi.bcScope ?? src.firm_bc_scope ?? null,
		iaScope: bi.iaScope ?? null,
		firmStatus: bi.firmStatus ?? null,
		firmStatusDate: bi.firmStatusDate ?? null,
		finraRegistered: bi.finraRegistered ?? null,
		iaSECNumber: bi.iaSECNumber ?? bi.iaSecNumber ?? null,
		firmName: bi.firmName ?? src.firm_name ?? src.firmName ?? null,
		_bi: bi,
	};
}

function parseIndividualHit(hit) {
	if (!hit) return null;
	const src = hit._source ?? {};
	let parsed = {};
	if (src.content)
		try {
			parsed = JSON.parse(src.content);
		} catch {}
	if (src.iacontent)
		try {
			parsed = JSON.parse(src.iacontent);
		} catch {}
	if (src.bccontent)
		try {
			parsed = JSON.parse(src.bccontent);
		} catch {}
	const bi = parsed.basicInformation ?? {};
	return {
		bcScope: bi.bcScope ?? src.ind_bc_scope ?? null,
		iaScope: bi.iaScope ?? src.ind_ia_scope ?? null,
		bcStatus: bi.bcStatus ?? null,
		firstName: bi.firstName ?? bi.ind_firstname ?? null,
		lastName: bi.lastName ?? bi.ind_lastname ?? null,
		_bi: bi,
	};
}

function firstHit(json) {
	return json?.hits?.hits?.[0] ?? null;
}

// ─── Determine live inactive status ──────────────────────────────────────────

/**
 * Returns true when the live upstream data clearly shows the node is
 * inactive / terminated across all its relevant registrations.
 *
 * Key rule: for firms, firmStatus=Terminated is a hard BD-level signal;
 * iaScope=ACTIVE is an IA-level signal and they can coexist legitimately
 * (a firm can terminate its BD registration while keeping its IA registration).
 * We report an anomaly only when the cached local node does NOT already
 * reflect an inactive state that matches what we see upstream.
 */
function liveStatusSummary(group, finraData, secData) {
	if (group === 'firm') {
		const finraFlags = finraData ? collectFlags([finraData.bcScope]) : { hasActive: false, hasInactive: false };

		// firmStatus = BD-level hard signal; iaScope = IA-level signal
		const bdFlags = secData ? collectFlags([secData.firmStatus, secData.bcScope]) : { hasActive: false, hasInactive: false };
		const iaFlags = secData ? collectFlags([secData.iaScope]) : { hasActive: false, hasInactive: false };

		const finra = liveFinraPresence(finraData?._bi ?? finraData);
		const sec = liveSecPresence(secData?._bi ?? secData);

		// A firm is considered "live inactive" only when:
		//  - its BD registration is terminated (finra or BD-side sec flags)
		//  - AND it has no active IA registration
		const bdInactive = finraFlags.hasInactive || bdFlags.hasInactive;
		const bdActive = finraFlags.hasActive || bdFlags.hasActive;
		const fullyInactive = bdInactive && !bdActive && !iaFlags.hasActive;

		return {
			finra,
			sec,
			sourceTruth:
				finra && sec ? 'both'
				: finra ? 'finra_only'
				: sec ? 'sec_only'
				: 'none',
			bdInactive,
			iaActive: iaFlags.hasActive,
			fullyInactive,
			// Raw values for the report
			bcScope: finraData?.bcScope ?? secData?.bcScope ?? null,
			iaScope: secData?.iaScope ?? null,
			firmStatus: secData?.firmStatus ?? finraData?.firmStatus ?? null,
		};
	}

	// individual
	const finra = liveFinraPresence(finraData?._bi ?? finraData);
	const sec = liveSecPresence(secData?._bi ?? secData);
	const flags = collectFlags([finraData?.bcScope, finraData?.bcStatus, secData?.iaScope, secData?.bcScope]);
	return {
		finra,
		sec,
		sourceTruth:
			finra && sec ? 'both'
			: finra ? 'finra_only'
			: sec ? 'sec_only'
			: 'none',
		bdInactive: false,
		iaActive: false,
		fullyInactive: flags.hasInactive && !flags.hasActive,
		bcScope: finraData?.bcScope ?? null,
		iaScope: secData?.iaScope ?? null,
		firmStatus: null,
	};
}

// ─── Graph reader ─────────────────────────────────────────────────────────────

async function loadGraph() {
	try {
		const raw = await fs.readFile(GRAPH_FILE, 'utf-8');
		return JSON.parse(raw);
	} catch (e) {
		console.warn(`Graph file not found or unreadable: ${GRAPH_FILE} — ${e.message}`);
		return { nodes: [], links: [] };
	}
}

function extractCrd(node) {
	if (!node) return null;
	// direct CRD fields
	if (node.crd) return String(node.crd);
	if (node.firmCrd) return String(node.firmCrd);
	// extract from id like "firm:3487" or "person:12345"
	const match = String(node.id || '').match(/^(?:firm|person):(\d+)$/);
	return match ? match[1] : null;
}

function localInactiveStatus(node) {
	const flags =
		node.group === 'firm' ?
			collectFlags([node.bcScope, node.basicInformation?.bcScope, node.firmStatus, node.basicInformation?.firmStatus])
		:	collectFlags([node.bcScope, node.basicInformation?.bcScope, node.bcStatus, node.basicInformation?.bcStatus, node.iaScope, node.basicInformation?.iaScope]);
	return { hasActive: flags.hasActive, hasInactive: flags.hasInactive };
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function runConcurrent(tasks, concurrency) {
	const results = [];
	let index = 0;
	async function worker() {
		while (index < tasks.length) {
			const i = index++;
			results[i] = await tasks[i]();
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	return results;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const startedAt = new Date().toISOString();
	console.log(`[daily_status_check] Starting at ${startedAt}`);
	console.log(`  concurrency=${argv.concurrency}  delay=${argv.delay}ms  dry-run=${argv.dryRun}`);
	if (argv.singleCrd) console.log(`  single-crd=${argv.singleCrd}`);

	const graph = await loadGraph();
	let nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

	if (argv.singleCrd) {
		nodes = nodes.filter((n) => extractCrd(n) === argv.singleCrd);
		if (!nodes.length) {
			console.error(`No node found for CRD ${argv.singleCrd}`);
			process.exit(1);
		}
	}

	const totalNodes = nodes.length;
	console.log(`  Graph nodes: ${totalNodes}`);

	const report = {
		generatedAt: startedAt,
		completedAt: null,
		totalNodes,
		checked: 0,
		skipped: 0,
		errors: 0,
		inactiveConfirmed: 0, // local=inactive, upstream=inactive — consistent
		activeConfirmed: 0, // local=active, upstream=active — consistent
		anomalies: [], // local shows active but upstream shows inactive
		inconsistencies: [], // local shows inactive but upstream shows active
		sourceTruthSummary: { finra_only: 0, sec_only: 0, both: 0, none: 0 },
	};

	// Build task list — batch to respect rate limits
	const BATCH = argv.concurrency;
	let processed = 0;

	for (let batchStart = 0; batchStart < nodes.length; batchStart += BATCH) {
		const batch = nodes.slice(batchStart, batchStart + BATCH);

		const tasks = batch.map((node) => async () => {
			const crd = extractCrd(node);
			if (!crd) {
				report.skipped++;
				return;
			}

			const group = node.group === 'firm' ? 'firm' : 'individual';

			// Determine which APIs to query based on local source truth signals
			const hasBcScope = classifyText(node.bcScope ?? node.basicInformation?.bcScope) !== 'not_in_scope';
			const hasIaScope = classifyText(node.iaScope ?? node.basicInformation?.iaScope) !== 'not_in_scope';
			const hasSecNum = Boolean(node.iaSecNumber ?? node.basicInformation?.iaSECNumber ?? node.basicInformation?.iaSecNumber);
			const hasSecData = node.hasSecData === true;
			const hasFinraData = node.hasFinraData === true || node.isLegacy === 'Y';

			const queryFinra = group === 'individual' ? hasBcScope || hasFinraData : hasBcScope || hasFinraData;
			const querySec = group === 'individual' ? hasIaScope || hasSecData : hasIaScope || hasSecData || hasSecNum;

			// Skip nodes with no known API source
			if (!queryFinra && !querySec) {
				report.skipped++;
				return;
			}

			let finraData = null;
			let secData = null;
			const errors = [];

			try {
				if (queryFinra) {
					const url = group === 'firm' ? finraFirmUrl(crd) : finraIndividualUrl(crd);
					const json = await fetchJson(url);
					finraData = group === 'firm' ? parseFirmHit(firstHit(json)) : parseIndividualHit(firstHit(json));
				}
			} catch (e) {
				errors.push(`FINRA: ${e.message}`);
			}

			try {
				if (querySec) {
					const url = group === 'firm' ? secFirmUrl(crd) : secIndividualUrl(crd);
					const json = await fetchJson(url);
					secData = group === 'firm' ? parseFirmHit(firstHit(json)) : parseIndividualHit(firstHit(json));
				}
			} catch (e) {
				errors.push(`SEC: ${e.message}`);
			}

			if (errors.length) report.errors++;

			const liveStatus = liveStatusSummary(group, finraData, secData);
			const localStatus = localInactiveStatus(node);

			report.checked++;
			report.sourceTruthSummary[liveStatus.sourceTruth]++;

			const nodeLabel = node.label ?? node.id ?? crd;
			const nodeInfo = {
				crd,
				id: node.id,
				label: nodeLabel,
				group,
				sourceTruth: `FINRA=${liveStatus.finra} · SEC=${liveStatus.sec} (${liveStatus.sourceTruth})`,
				live: {
					bcScope: liveStatus.bcScope,
					iaScope: liveStatus.iaScope,
					firmStatus: liveStatus.firmStatus,
					fullyInactive: liveStatus.fullyInactive,
					bdInactive: liveStatus.bdInactive,
					iaActive: liveStatus.iaActive,
				},
				local: {
					hasActive: localStatus.hasActive,
					hasInactive: localStatus.hasInactive,
					bcScope: node.bcScope ?? node.basicInformation?.bcScope ?? null,
					iaScope: node.iaScope ?? node.basicInformation?.iaScope ?? null,
					firmStatus: node.firmStatus ?? node.basicInformation?.firmStatus ?? null,
				},
			};

			if (errors.length) nodeInfo.errors = errors;

			// Anomaly: local shows active but upstream says fully inactive
			if (liveStatus.fullyInactive && !localStatus.hasInactive) {
				report.anomalies.push({ ...nodeInfo, issue: 'upstream_inactive_local_active' });
				return;
			}

			// Inconsistency: local says inactive but upstream says active
			if (!liveStatus.fullyInactive && localStatus.hasInactive && !localStatus.hasActive) {
				// Only flag if upstream actually returned data (not just a gap)
				if (finraData || secData) {
					report.inconsistencies.push({ ...nodeInfo, issue: 'upstream_active_local_inactive' });
					return;
				}
			}

			if (liveStatus.fullyInactive) report.inactiveConfirmed++;
			else report.activeConfirmed++;
		});

		await runConcurrent(tasks, BATCH);
		processed += batch.length;

		if (processed % 500 === 0 || processed >= nodes.length) {
			const pct = ((processed / nodes.length) * 100).toFixed(1);
			console.log(`  Progress: ${processed}/${nodes.length} (${pct}%)  anomalies=${report.anomalies.length}  inconsistencies=${report.inconsistencies.length}`);
		}

		if (batchStart + BATCH < nodes.length && argv.delay > 0) {
			await sleep(argv.delay);
		}
	}

	report.completedAt = new Date().toISOString();

	// ── Console summary ──────────────────────────────────────────────────────
	console.log('\n─── Daily Status Check Report ─────────────────────────────────');
	console.log(`  Completed : ${report.completedAt}`);
	console.log(`  Nodes     : total=${report.totalNodes}  checked=${report.checked}  skipped=${report.skipped}  errors=${report.errors}`);
	console.log(`  Status    : active_confirmed=${report.activeConfirmed}  inactive_confirmed=${report.inactiveConfirmed}`);
	console.log(
		`  Source    : finra_only=${report.sourceTruthSummary.finra_only}  sec_only=${report.sourceTruthSummary.sec_only}  both=${report.sourceTruthSummary.both}  none=${report.sourceTruthSummary.none}`,
	);
	console.log(`  ⚠  Anomalies (upstream=inactive, local=active) : ${report.anomalies.length}`);
	if (report.anomalies.length) {
		for (const a of report.anomalies.slice(0, 5)) {
			console.log(`      • [${a.group}] ${a.label} (CRD ${a.crd}) — ${a.sourceTruth}`);
			console.log(`        live: bcScope=${a.live.bcScope} iaScope=${a.live.iaScope} firmStatus=${a.live.firmStatus}`);
		}
		if (report.anomalies.length > 5) console.log(`      … and ${report.anomalies.length - 5} more`);
	}
	console.log(`  ℹ  Inconsistencies (upstream=active, local=inactive) : ${report.inconsistencies.length}`);
	console.log('───────────────────────────────────────────────────────────────\n');

	if (!argv.dryRun) {
		try {
			await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
		} catch {}
		await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8');
		console.log(`Report written → ${REPORT_FILE}`);
	} else {
		console.log('(dry-run: report not written to disk)');
	}

	const exitCode = report.anomalies.length > 0 ? 1 : 0;
	process.exit(exitCode);
}

main().catch((e) => {
	console.error('[daily_status_check] Fatal error:', e);
	process.exit(2);
});
