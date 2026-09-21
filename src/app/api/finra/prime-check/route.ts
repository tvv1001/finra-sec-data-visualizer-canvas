import { NextRequest, NextResponse } from 'next/server';
import { cachedFetch } from '@/lib/simpleCache';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { getFullGraph, getSeedBankFromStore } from '@/lib/graphStore';
import { logger } from '@/lib/logger';
import { isValidCrd, makeRedisKey, ensurePersonCrd, ensureFirmCrd } from '@/lib/crd';
import { Redis as UpstashRedis } from '@upstash/redis';
import { zaddRaw } from '@/lib/upstashHelpers';
import { getRecentSeedsFromStore } from '@/lib/seedStore';

function getUpstashClient() {
	try {
		// prefer MIRROR env var but fall back to legacy _2 names
		const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
		const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
		if (url && token) return new UpstashRedis({ url, token });
	} catch (e) {
		// ignore
	}
	return null;
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 30;

const DEFAULT_LIMIT = Number(process.env.FINRA_PRIME_BATCH_LIMIT || 24);
const DEFAULT_CONCURRENCY = Number(process.env.FINRA_PRIME_CONCURRENCY || 4);

const INDIVIDUAL_QUERY = new URLSearchParams({
	hl: 'true',
	includePrevious: 'true',
	wt: 'json',
}).toString();

const FIRM_QUERY = new URLSearchParams({
	hl: 'true',
	wt: 'json',
}).toString();

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	return request.headers.get('authorization') === `Bearer ${secret}`;
}

function summarizeStats(graph: any, seedBank: any) {
	const links = Array.isArray(graph?.links) ? graph.links.length : 0;
	return {
		people: seedBank?.counts?.individuals ?? 0,
		firms: seedBank?.counts?.firms ?? 0,
		entities: seedBank?.counts?.entities ?? 0,
		totalNodes: seedBank?.counts?.totalNodes ?? (Array.isArray(graph?.nodes) ? graph.nodes.length : 0),
		links,
		generated: graph?.meta?.generated ?? null,
		seedBankUpdatedAt: seedBank?.updatedAt ?? null,
	};
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
	let nextIndex = 0;
	const runWorker = async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			await worker(items[currentIndex]);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => runWorker()));
}

async function warmIndividual(crd: string) {
	const { default: axios } = await import('axios');
	const fetchQuery = INDIVIDUAL_QUERY; // still use includePrevious=true when hitting the API
	const s = String(crd || '').trim();
	if (!isValidCrd(s)) throw new Error(`invalid individual CRD: ${crd}`);
	const crdNorm = ensurePersonCrd(s);
	await Promise.allSettled([
		cachedFetch(makeRedisKey('finra', 'individual', crdNorm), 60 * 60 * 24, async () => {
			try {
				const response = await axios.get(`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`, {
					headers: DEFAULT_HEADERS,
					timeout: 15000,
				});
				return response.data;
			} catch (err: any) {
				if (err?.response?.status === 429) {
					try {
						const r = getUpstashClient();
						if (r) await zaddRaw(r, 'finra:retry', Date.now() + 10 * 60 * 1000, JSON.stringify({ type: 'individual', crd }));
					} catch (e) {
						// ignore redis errors
					}
				}
				throw err;
			}
		}),
		cachedFetch(makeRedisKey('sec', 'individual', crdNorm), 60 * 60 * 24, async () => {
			try {
				const response = await axios.get(`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`, {
					headers: DEFAULT_HEADERS,
					timeout: 15000,
				});
				return response.data;
			} catch (err: any) {
				if (err?.response?.status === 429) {
					try {
						const r = getUpstashClient();
						if (r) await zaddRaw(r, 'finra:retry', Date.now() + 10 * 60 * 1000, JSON.stringify({ type: 'individual', crd }));
					} catch (e) {
						// ignore
					}
				}
				throw err;
			}
		}),
	]);
}

async function warmFirm(id: string) {
	const { default: axios } = await import('axios');
	const s = String(id || '').trim();
	if (!isValidCrd(s)) throw new Error(`invalid firm CRD: ${id}`);
	const idNorm = ensureFirmCrd(s);
	await Promise.allSettled([
		cachedFetch(makeRedisKey('finra', 'firm', idNorm), 60 * 60 * 24, async () => {
			try {
				const response = await axios.get(`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?${FIRM_QUERY}`, {
					headers: DEFAULT_HEADERS,
					timeout: 15000,
				});
				return response.data;
			} catch (err: any) {
				if (err?.response?.status === 429) {
					try {
						const r = getUpstashClient();
						if (r) await zaddRaw(r, 'finra:retry', Date.now() + 10 * 60 * 1000, JSON.stringify({ type: 'firm', id }));
					} catch (e) {
						// ignore
					}
				}
				throw err;
			}
		}),
		cachedFetch(makeRedisKey('sec', 'firm', idNorm), 60 * 60 * 24, async () => {
			try {
				const response = await axios.get(`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?wt=json`, {
					headers: DEFAULT_HEADERS,
					timeout: 15000,
				});
				return response.data;
			} catch (err: any) {
				if (err?.response?.status === 429) {
					try {
						const r = getUpstashClient();
						if (r) await zaddRaw(r, 'finra:retry', Date.now() + 10 * 60 * 1000, JSON.stringify({ type: 'firm', id }));
					} catch (e) {
						// ignore
					}
				}
				throw err;
			}
		}),
		cachedFetch(`sec:firm:summaryHtml:${idNorm}`, 60 * 60 * 24, async () => {
			try {
				const response = await axios.get(`https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(id)}`, {
					headers: DEFAULT_HEADERS,
					timeout: 15000,
				});
				return response.data;
			} catch (err: any) {
				if (err?.response?.status === 429) {
					try {
						const r = getUpstashClient();
						if (r) await zaddRaw(r, 'finra:retry', Date.now() + 10 * 60 * 1000, JSON.stringify({ type: 'firm', id }));
					} catch (e) {
						// ignore
					}
				}
				throw err;
			}
		}),
	]);
}

function extractFdaDockets(detail: any) {
	const disclosures = Array.isArray(detail?.disclosures) ? detail.disclosures : [];
	const dockets = new Set<string>();

	for (const disclosure of disclosures) {
		const dd = disclosure?.disclosureDetail;
		if (!dd || typeof dd !== 'object' || Array.isArray(dd)) continue;
		const docket = String(dd.DocketNumberFDA || '').trim();
		if (docket) dockets.add(docket);
	}

	return Array.from(dockets);
}

async function fetchLocalJson(origin: string, path: string) {
	const response = await fetch(`${origin}${path}`, {
		headers: {
			'Accept': 'application/json',
			'x-finra-prime-check': '1',
		},
		cache: 'no-store',
	});

	let payload: any = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		throw new Error(payload?.error || `HTTP ${response.status}`);
	}

	return payload;
}

export async function GET(request: NextRequest) {
	const { setExternalApiContext } = await import('@/lib/externalApiGate');
	const previousContext = process.env.EXTERNAL_API_CONTEXT;
	setExternalApiContext('cronjob');

	try {
		if (!isAuthorized(request)) {
			return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const origin = request.nextUrl.origin;
		const limit = Number(searchParams.get('limit') || DEFAULT_LIMIT);
		const concurrency = Number(searchParams.get('concurrency') || DEFAULT_CONCURRENCY);

		// measure duration for telemetry
		const startMs = Date.now();

		// init upstash redis client if configured
		let upstash: any = null;
		try {
			const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
			const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
			if (url && token) upstash = new UpstashRedis({ url, token });
		} catch (e) {
			upstash = null;
		}

		// If Redis contains a graph with >= 70000 nodes, skip warming work
		try {
			if (upstash) {
				const rawGraph = await upstash.get('graph:snapshot');
				if (rawGraph) {
					try {
						const parsed = typeof rawGraph === 'string' ? JSON.parse(rawGraph) : rawGraph;
						const totalNodes = Array.isArray(parsed?.nodes) ? parsed.nodes.length : parsed?.nodes?.length || 0;
						if (totalNodes >= 70000) {
							return NextResponse.json(
								{ ok: true, reason: 'target-count-reached', totalNodes },
								{ headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
							);
						}
					} catch (e) {
						// ignore parse errors and continue
					}
				}
			}
		} catch (e) {
			// ignore redis errors and continue
		}

		// Before normal warm of recent seeds, process any due retry entries (zset 'finra:retry')
		if (upstash) {
			try {
				const now = Date.now();
				// zrangebyscore returns members with score between -inf and now
				const due = await upstash.zrangebyscore('finra:retry', 0, now);
				if (Array.isArray(due) && due.length > 0) {
					for (const member of due) {
						try {
							const obj = JSON.parse(member);
							if (obj && obj.type === 'individual' && obj.crd) {
								// attempt to warm the individual cache (best-effort)
								try {
									await warmIndividual(String(obj.crd));
								} catch (e) {
									// if 429 again, we'll reschedule below when warming recent seeds normally
								}
							} else if (obj && obj.type === 'firm' && obj.id) {
								try {
									await warmFirm(String(obj.id));
								} catch (e) {
									// ignore
								}
							}
						} catch (e) {
							// ignore malformed member
						}
					}
					// remove processed entries
					try {
						await upstash.zrem('finra:retry', ...due);
					} catch (e) {
						/* ignore */
					}
				}
			} catch (e) {
				// ignore redis errors
			}
		}

		const [beforeGraph, beforeSeedBank, recentSeeds] = await Promise.all([getFullGraph(), getSeedBankFromStore(), getRecentSeedsFromStore()]);
		const before = summarizeStats(beforeGraph, beforeSeedBank);

		const warmTargets = [
			...recentSeeds.individualIds.slice(0, limit).map((id) => ({ kind: 'individual' as const, id })),
			...recentSeeds.firmIds.slice(0, limit).map((id) => ({ kind: 'firm' as const, id })),
		].slice(0, Math.max(1, limit * 2));

		const results = {
			warmedIndividuals: 0,
			warmedFirms: 0,
			fdaChecks: {
				individualsScanned: 0,
				docketsQueued: 0,
				docketsChecked: 0,
				found: 0,
				blocked: 0,
				noResults: 0,
				failures: [] as Array<{ crd: string; docket: string; error: string }>,
			},
			failures: [] as Array<{ kind: 'individual' | 'firm' | 'missing'; id: string; error: string }>,
		};
		const seenFdaDockets = new Set<string>();

		// Expose these variables outside the try block so telemetry can reference them
		let missingToProcess: string[] = [];
		let runExternalWarm = false;

		// 1) Always check for missing CRDs (present in seed bank but not in graph)
		const missing: string[] = [];
		try {
			const presentIds = new Set(Array.isArray(beforeGraph?.nodes) ? beforeGraph.nodes.map((n: any) => String(n.id)) : []);
			for (const id of beforeSeedBank?.allNodeIds || []) {
				if (!presentIds.has(id)) missing.push(id);
			}
		} catch (e) {
			// ignore errors building missing list
		}

		const MAX_MISSING_PER_RUN = Number(process.env.FINRA_PRIME_MISSING_LIMIT || 200);
		missingToProcess = missing.slice(0, MAX_MISSING_PER_RUN);
		if (missingToProcess.length > 0) {
			await runWithConcurrency(missingToProcess, Math.max(1, Math.min(6, concurrency)), async (nodeId) => {
				try {
					const s = String(nodeId || '');
					if (s.startsWith('person:') || /^\d+$/.test(s)) {
						const crd = s.replace(/^person[:_]?/, '');
						await warmIndividual(crd);
						results.warmedIndividuals += 1;
					} else if (s.startsWith('firm:')) {
						const fid = s.replace(/^firm[:_]?/, '');
						await warmFirm(fid);
						results.warmedFirms += 1;
					}
				} catch (e: any) {
					results.failures.push({ kind: 'missing', id: String(nodeId), error: String(e?.message || e) });
				}
			});
		}

		// 2) Deterministic spacing for external warms using Redis key `finra:next-external-run`.
		// If Upstash is available, the route will only run an external warm when now >= next-external-run.
		// After running, it sets the next-external-run to now + random(6..18 minutes).
		const EXTERNAL_WARM_PROB = Number(process.env.FINRA_PRIME_EXTERNAL_PROB || 0.3333);
		// honor explicit forceExternal query param if present
		try {
			const urlObj = new URL(request.url);
			if (urlObj.searchParams.get('forceExternal') === '1') {
				runExternalWarm = true;
			}
		} catch (e) {}

		if (upstash) {
			try {
				const now = Date.now();
				const rawNext = await upstash.get('finra:next-external-run').catch(() => null);
				const nextTs = Number(rawNext) || 0;

				if (runExternalWarm) {
					// forced run: schedule next run
					const delayMin = 6 + Math.floor(Math.random() * 13); // 6..18
					const next = now + delayMin * 60 * 1000;
					try {
						await upstash.set('finra:next-external-run', String(next));
					} catch (e) {
						// ignore set errors
					}
					runExternalWarm = true;
				} else if (!nextTs || now >= nextTs) {
					// allowed to run now; schedule next
					const delayMin = 6 + Math.floor(Math.random() * 13);
					const next = now + delayMin * 60 * 1000;
					try {
						await upstash.set('finra:next-external-run', String(next));
					} catch (e) {
						// ignore
					}
					runExternalWarm = true;
				} else {
					// not yet time for an external warm
					runExternalWarm = false;
				}
			} catch (e) {
				// If Redis fails, fallback to probabilistic behavior so cron still does something
				runExternalWarm = Math.random() < EXTERNAL_WARM_PROB;
			}
		} else {
			// no Upstash configured — fall back to probabilistic intermittent warm
			runExternalWarm = Math.random() < EXTERNAL_WARM_PROB;
		}

		if (runExternalWarm) {
			await runWithConcurrency(warmTargets, concurrency, async (target) => {
				try {
					if (target.kind === 'individual') {
						await warmIndividual(target.id);
						results.warmedIndividuals += 1;
						results.fdaChecks.individualsScanned += 1;

						const detail = await fetchLocalJson(origin, `/api/finra/individual/${encodeURIComponent(target.id)}`);
						if (detail?.found === false) return;

						for (const docket of extractFdaDockets(detail)) {
							if (seenFdaDockets.has(docket)) continue;
							seenFdaDockets.add(docket);
							results.fdaChecks.docketsQueued += 1;

							try {
								const fdaResult = await fetchLocalJson(origin, `/api/finra/fda/${encodeURIComponent(docket)}`);
								results.fdaChecks.docketsChecked += 1;
								if (fdaResult?.blocked) results.fdaChecks.blocked += 1;
								else if (fdaResult?.found) results.fdaChecks.found += 1;
								else results.fdaChecks.noResults += 1;
							} catch (error: any) {
								results.fdaChecks.failures.push({ crd: target.id, docket, error: String(error?.message || error) });
								logger.warn('prime-check FDA lookup failed', { crd: target.id, docket, error: error?.message || String(error) });
							}
						}
						return;
					}
					await warmFirm(target.id);
					results.warmedFirms += 1;
				} catch (error: any) {
					results.failures.push({ kind: target.kind, id: target.id, error: String(error?.message || error) });
				}
			});
		} else {
			logger.info('prime-check skipped external warm this run (intermittent)', { prob: EXTERNAL_WARM_PROB });
		}

		const [afterGraph, afterSeedBank] = await Promise.all([getFullGraph(), getSeedBankFromStore()]);
		const after = summarizeStats(afterGraph, afterSeedBank);
		const changed = before.people !== after.people || before.firms !== after.firms || before.links !== after.links || before.totalNodes !== after.totalNodes;

		logger.info('prime-check completed', {
			mode: 'daily-usage-aware-prime-check',
			limit,
			concurrency,
			recentSeeds: {
				individualsQueued: recentSeeds.individualIds.length,
				firmsQueued: recentSeeds.firmIds.length,
				updatedAt: recentSeeds.updatedAt,
			},
			results: {
				warmedIndividuals: results.warmedIndividuals,
				warmedFirms: results.warmedFirms,
				failures: results.failures.length,
				fdaChecks: {
					individualsScanned: results.fdaChecks.individualsScanned,
					docketsQueued: results.fdaChecks.docketsQueued,
					docketsChecked: results.fdaChecks.docketsChecked,
					found: results.fdaChecks.found,
					blocked: results.fdaChecks.blocked,
					noResults: results.fdaChecks.noResults,
					failures: results.fdaChecks.failures.length,
				},
			},
			changed,
		});

		// Push a compact telemetry entry to `finra:redis-monitor` for auditing/metrics
		try {
			const endMs = Date.now();
			const durationMs = endMs - startMs;
			const monitorEntry = {
				ts: new Date().toISOString(),
				action: 'prime-check',
				mode: runExternalWarm ? 'external-warm' : 'missing-only',
				externalWarmRun: Boolean(runExternalWarm),
				missingProcessed: Array.isArray(missingToProcess) ? missingToProcess.length : 0,
				warmedIndividuals: results.warmedIndividuals,
				warmedFirms: results.warmedFirms,
				failures: results.failures.length,
				fdaChecks: {
					checked: results.fdaChecks.docketsChecked,
					found: results.fdaChecks.found,
					blocked: results.fdaChecks.blocked,
					noResults: results.fdaChecks.noResults,
					failures: results.fdaChecks.failures.length,
				},
				recentSeedsQueued: { individuals: recentSeeds.individualIds.length, firms: recentSeeds.firmIds.length },
				before: before,
				after: after,
				durationMs,
				source: 'cron',
			};

			try {
				if (upstash) {
					await upstash.lpush('finra:redis-monitor', JSON.stringify(monitorEntry));
					await upstash.ltrim('finra:redis-monitor', 0, 199);
				}
				// Increment lightweight counters for quick metrics aggregation
				try {
					if (upstash) {
						await upstash.incr('finra:metrics:prime-check:total_runs');
						if (runExternalWarm) await upstash.incr('finra:metrics:prime-check:external_runs');
						if (Array.isArray(missingToProcess) && missingToProcess.length > 0) await upstash.incrby('finra:metrics:prime-check:missing_processed', missingToProcess.length);
						if (results.warmedIndividuals) await upstash.incrby('finra:metrics:prime-check:warmed_individuals', results.warmedIndividuals);
						if (results.warmedFirms) await upstash.incrby('finra:metrics:prime-check:warmed_firms', results.warmedFirms);
						const totalFailures = results.failures.length + results.fdaChecks.failures.length;
						if (totalFailures) await upstash.incrby('finra:metrics:prime-check:failures', totalFailures);
					}
				} catch (err) {
					logger.warn('prime-check: failed to increment metric counters', { error: String(err?.message || err) });
				}
			} catch (err) {
				logger.warn('prime-check: failed to push monitor entry to redis', { error: String(err?.message || err) });
			}
			logger.info('prime-check: monitor entry', monitorEntry);
		} catch (e) {
			// non-fatal telemetry error
			logger.warn('prime-check: telemetry error', { error: String(e?.message || e) });
		}

		return NextResponse.json(
			{
				ok: true,
				mode: 'daily-usage-aware-prime-check',
				limit,
				concurrency,
				recentSeeds: {
					individualsQueued: recentSeeds.individualIds.length,
					firmsQueued: recentSeeds.firmIds.length,
					updatedAt: recentSeeds.updatedAt,
				},
				results,
				before,
				after,
				changed,
			},
			{
				headers: {
					'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
				},
			},
		);
	} catch (error: any) {
		return NextResponse.json(
			{ ok: false, error: String(error?.message || error), results: {}, before: {}, recentSeeds: {} },
			{ status: 500, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	} finally {
		setExternalApiContext(previousContext || null);
	}
}
