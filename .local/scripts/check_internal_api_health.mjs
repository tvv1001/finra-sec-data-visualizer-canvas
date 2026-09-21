#!/usr/bin/env node
/*
 * check_internal_api_health.mjs
 *
 * Validates the health/correctness of this app's own internal FINRA/SEC proxy APIs
 * (/api/finra/individual/<crd>, /api/finra/firm/<id>, /api/finra/firm/<id>/connections),
 * independent of upstream data quality. This answers: "are our own routes behaving
 * correctly right now?" — not "is the CRD data itself correct?" (see
 * scripts/revalidate_firm_connections.mjs for that).
 *
 * Checks performed:
 *  1. Upstream reachability: does a raw call to FINRA/SEC succeed, 429, or error?
 *  2. Rate-limit signal propagation: when upstream returns 429, does our internal
 *     /api/finra/individual/<crd> route correctly surface `rateLimited: true` +
 *     HTTP 429 (as opposed to silently masking it as `{found:false}` with HTTP 200,
 *     which is indistinguishable from "CRD genuinely not found" and previously caused
 *     the revalidate_firm_connections.mjs background job to spin for 21+ hours
 *     believing every result was "unknown" rather than backing off).
 *  3. Known-good CRD smoke test: fetch a small set of CRDs already cached locally
 *     (finra:individual:<crd> / sec:individual:<crd>) with forceRefresh=0 and confirm the route
 *     still returns `found:true` with a plausible detail shape (basicInformation/name).
 *  4. Firm connections shape check: confirm /api/finra/firm/<id>/connections returns
 *     currentConnections/previousConnections arrays with individualId + evidence for a
 *     small sample of firms, and reports what fraction have a resolved `name` (i.e. how
 *     much of the panel will render CRD-only rows vs. named rows) as an early-warning
 *     data-quality signal alongside the correctness checks.
 *
 * Usage:
 *   node scripts/check_internal_api_health.mjs [--base http://localhost:4444] [--firm 123635] [--crd 1512556]
 *
 * Exit code: 0 if all correctness checks pass, 1 if any hard failure (e.g. 429 masked as 200).
 * Upstream being currently rate-limited is reported but is NOT a failure (it's expected/known).
 */
import Redis from 'ioredis';

const args = process.argv.slice(2);
function argVal(name, def) {
	const i = args.indexOf(`--${name}`);
	if (i >= 0 && args[i + 1]) return args[i + 1];
	return def;
}
const BASE = argVal('base', 'http://localhost:4444');
const SAMPLE_FIRM = argVal('firm', null);
const SAMPLE_CRD = argVal('crd', null);

const redis = new Redis('redis://127.0.0.1:6379');

const results = { pass: [], fail: [], warn: [] };
function pass(msg) {
	results.pass.push(msg);
	console.log(`  \u2713 ${msg}`);
}
function fail(msg) {
	results.fail.push(msg);
	console.log(`  \u2717 ${msg}`);
}
function warn(msg) {
	results.warn.push(msg);
	console.log(`  \u26a0 ${msg}`);
}

async function checkExternalApiGateConfig() {
	console.log('\n[0] External API gate configuration (canCallExternalApis)');
	// This gate (src/lib/externalApiGate.ts) short-circuits ALL external FINRA/SEC fetches in
	// simpleCache.ts's cachedFetch() to `undefined` UNLESS EXTERNAL_API_CONTEXT=cronjob (only set
	// internally by /api/finra/prime-check and /api/finra/external-validity) or EXTERNAL_API_DISABLED
	// is explicitly '0'/'false'. This means direct calls like
	// /api/finra/individual/<crd>?forceRefresh=1 from any other route, script, or browser action
	// NEVER reach upstream on localhost — they silently return {found:false} indistinguishable from
	// a genuine 404, which previously caused revalidate_firm_connections.mjs to run for 21+ hours
	// believing every CRD was "unknown" without ever actually contacting FINRA/SEC.
	const disabledEnv = process.env.EXTERNAL_API_DISABLED;
	const contextEnv = process.env.EXTERNAL_API_CONTEXT;
	const explicitlyEnabled = disabledEnv === '0' || String(disabledEnv).toLowerCase() === 'false';
	const isVercel = process.env.VERCEL === '1';
	if (isVercel) {
		pass('running on Vercel — gate defaults to enabled unless EXTERNAL_API_DISABLED=1/true');
		return;
	}
	if (contextEnv === 'cronjob' || explicitlyEnabled) {
		pass(`gate is open in this process (EXTERNAL_API_CONTEXT=${contextEnv || 'unset'}, EXTERNAL_API_DISABLED=${disabledEnv || 'unset'})`);
		return;
	}
	warn(
		'gate is CLOSED for this script\'s own process env (expected — the script itself does not set EXTERNAL_API_CONTEXT). ' +
			'This is only a real problem if the running Next.js dev/prod server ALSO has no EXTERNAL_API_CONTEXT=cronjob and no EXTERNAL_API_DISABLED=0 set — ' +
			'in that case, forceRefresh=1 calls to /api/finra/individual/<crd> and /api/finra/firm/<id> silently no-op against upstream. ' +
			'Verify by checking check [2] below: if it warns "cannot exercise" while upstream is confirmed rate-limited via curl in [1], the gate is very likely blocking the app server too.',
	);
}

async function checkUpstreamReachability() {
	console.log('\n[1] Upstream reachability (direct, bypassing our app)');
	const targets = [
		{ name: 'FINRA BrokerCheck', url: 'https://api.brokercheck.finra.org/search/individual/1512556?hl=true&wt=json' },
		{ name: 'SEC AdviserInfo', url: 'https://api.adviserinfo.sec.gov/search/individual/1512556?wt=json' },
	];
	const status = {};
	for (const t of targets) {
		try {
			const res = await fetch(t.url, { headers: { Accept: 'application/json' } });
			const retryAfter = res.headers.get('retry-after');
			status[t.name] = { httpStatus: res.status, retryAfter };
			if (res.status === 429) {
				warn(`${t.name}: rate-limited (429, retry-after=${retryAfter ?? 'n/a'}s) — expected during heavy crawling, not a bug`);
			} else if (res.ok) {
				pass(`${t.name}: reachable (HTTP ${res.status})`);
			} else {
				warn(`${t.name}: unexpected status HTTP ${res.status}`);
			}
		} catch (err) {
			warn(`${t.name}: network error — ${err.message}`);
			status[t.name] = { error: err.message };
		}
	}
	return status;
}

async function checkRateLimitPropagation(upstreamStatus) {
	console.log('\n[2] Internal route rate-limit signal propagation');
	const anyUpstreamRateLimited = Object.values(upstreamStatus).some((s) => s.httpStatus === 429);
	if (!anyUpstreamRateLimited) {
		warn('Upstream is not currently rate-limited — cannot exercise the 429-propagation path right now. Re-run this check while upstream is limited to fully validate.');
		return;
	}
	// Use an uncached CRD so the route is forced to hit upstream (forceRefresh + a CRD unlikely
	// to be locally cached already). Fall back to the provided --crd or a a high, unlikely-cached CRD.
	const probeCrd = SAMPLE_CRD || '9999999';
	const url = `${BASE}/api/finra/individual/${encodeURIComponent(probeCrd)}?merged=1&forceRefresh=1&write=0`;
	let res;
	try {
		res = await fetch(url, { headers: { Accept: 'application/json' } });
	} catch (err) {
		fail(`internal route unreachable: ${err.message}`);
		return;
	}
	let json = null;
	try {
		json = await res.json();
	} catch {}
	if (res.status === 429 && json?.rateLimited === true) {
		pass(`internal route correctly surfaces upstream 429 as HTTP 429 with rateLimited:true (retryAfterSec=${json.retryAfterSec ?? 'n/a'})`);
	} else if (res.status === 200 && json?.found === false && !json?.rateLimited) {
		fail(`internal route masked an upstream 429 as HTTP 200 {found:false} — rate-limit signal is NOT propagating (this breaks backoff logic in dependent scripts like revalidate_firm_connections.mjs)`);
	} else {
		warn(`internal route returned an unexpected shape while upstream was rate-limited: HTTP ${res.status} body=${JSON.stringify(json).slice(0, 200)}`);
	}
}

async function checkKnownGoodCrds() {
	console.log('\n[3] Known-good (already-cached) CRD smoke test');
	const finraKeys = await redis.keys('finra:individual:*');
	const secKeys = await redis.keys('sec:individual:*');
	const sample = [...new Set([...finraKeys, ...secKeys].map((k) => k.split(':').pop()))].slice(0, 5);
	if (!sample.length) {
		warn('no cached individual CRDs found locally to sample — skipping');
		return;
	}
	for (const crd of sample) {
		const url = `${BASE}/api/finra/individual/${encodeURIComponent(crd)}?merged=1`;
		try {
			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			const json = await res.json();
			const hasName = Boolean(json?.basicInformation?.firstName || json?.basicInformation?.lastName || json?.firstName || json?.lastName || json?.orphan?.name);
			if (res.ok && json?.found === true && hasName) {
				pass(`crd ${crd}: found=true with a resolvable name`);
			} else if (res.ok && json?.found === true) {
				warn(`crd ${crd}: found=true but no resolvable name field in response`);
			} else {
				fail(`crd ${crd}: expected found=true for a locally-cached CRD, got found=${json?.found} (HTTP ${res.status})`);
			}
		} catch (err) {
			fail(`crd ${crd}: request error — ${err.message}`);
		}
	}
}

async function checkFirmConnectionsShape() {
	console.log('\n[4] Firm connections route shape + data-quality sample');
	const firmKeys = await redis.keys('firm-connections:firm:*');
	const sampleFirms = SAMPLE_FIRM ? [SAMPLE_FIRM] : firmKeys.map((k) => (k.match(/^firm-connections:firm:(\d+)$/) || [])[1]).filter(Boolean).slice(0, 5);
	for (const firmId of sampleFirms) {
		const url = `${BASE}/api/finra/firm/${encodeURIComponent(firmId)}/connections`;
		try {
			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			const json = await res.json();
			const cur = Array.isArray(json?.currentConnections) ? json.currentConnections : null;
			const prev = Array.isArray(json?.previousConnections) ? json.previousConnections : null;
			if (!res.ok || !cur || !prev) {
				fail(`firm ${firmId}: malformed connections response (HTTP ${res.status}, currentConnections=${!!cur}, previousConnections=${!!prev})`);
				continue;
			}
			const all = [...cur, ...prev];
			const withName = all.filter((c) => c?.name).length;
			const withEvidence = all.filter((c) => Array.isArray(c?.evidence) && c.evidence.length > 0).length;
			const pctNamed = all.length ? Math.round((withName / all.length) * 100) : 100;
			pass(`firm ${firmId}: ${all.length} connections, shape OK, evidence present on ${withEvidence}/${all.length}`);
			if (pctNamed < 50) {
				warn(`firm ${firmId}: only ${pctNamed}% of connections have a resolved name — likely still broker-id-mirror-only (unvalidated); consider running revalidate_firm_connections.mjs for this firm once upstream is not rate-limited`);
			} else {
				console.log(`    (${pctNamed}% of connections have resolved names)`);
			}
		} catch (err) {
			fail(`firm ${firmId}: request error — ${err.message}`);
		}
	}
}

async function main() {
	console.log(`check_internal_api_health starting. base=${BASE}`);
	const upstreamStatus = await checkUpstreamReachability();
	await checkRateLimitPropagation(upstreamStatus);
	await checkKnownGoodCrds();
	await checkFirmConnectionsShape();

	console.log(`\n=== Summary: ${results.pass.length} passed, ${results.warn.length} warnings, ${results.fail.length} failed ===`);
	await redis.quit();
	process.exit(results.fail.length ? 1 : 0);
}

main().catch((err) => {
	console.error('check_internal_api_health crashed:', err);
	process.exit(2);
});
