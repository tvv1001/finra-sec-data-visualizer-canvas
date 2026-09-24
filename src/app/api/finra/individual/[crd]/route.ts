import { NextRequest, NextResponse } from 'next/server';
import { canCallExternalApis } from '@/lib/externalApiGate';
import axios from 'axios';
import { cachedFetch, evictCacheKey } from '@/lib/simpleCache';
import { setStringIfValid } from '@/lib/redisCache';
import { isValidCrd, ensurePersonCrd, makeRedisKey } from '@/lib/crd';
import { rememberRecentSeed } from '@/lib/seedStore';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';
import { normalizeIndividualDetailFromSource } from '@/lib/individualDetail';
import { hasIndividualSourceCoverage, resolveIndividualSourceDetail } from '@/lib/sourceTruth';
import { queueHydration } from '@/lib/hydration';
import { getRedisClientInstance } from '@/lib/redisClient';
import { addRecordToSearchIndex } from '@/lib/localSearch';
import { lookupOwnerReference, recordOwnerReference } from '@/lib/ownerReferenceIndex';
import { extractIndividualEmployerLinksFromDetail, upsertIndividualIntoEmployerFirmConnections } from '@/lib/graphConnections';
import { rememberCrdLogEntries } from '@/lib/crdLog';
import { rememberInventoryEntities } from '@/lib/crdInventorySidecar';
import { canWriteToRedis } from '@/lib/redisAvailability';

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const source = data.hits.hits[0]?._source || {};
		try {
			return resolveIndividualSourceDetail(source)?.detail ?? null;
		} catch (err: any) {
			logger.warn('failed to resolve individual search hit detail', { error: err?.message || String(err) });
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return normalizeIndividualDetailFromSource(typeof raw === 'string' ? JSON.parse(raw) : raw || {});
		} catch (error) {
			try {
				return normalizeIndividualDetailFromSource(data);
			} catch (err: any) {
				logger.warn('failed to normalize individual detail payload', { error: err?.message || String(err) });
				return null;
			}
		}
	}

	if (isPlainObject(data)) {
		const looksLikeDetail =
			data.basicInformation ||
			data.individualId ||
			data.firstName ||
			data.lastName ||
			data.bcScope ||
			data.iaScope ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments;
		if (looksLikeDetail) {
			try {
				return normalizeIndividualDetailFromSource(data);
			} catch (err: any) {
				logger.warn('failed to normalize individual detail object', { error: err?.message || String(err) });
				return null;
			}
		}
	}

	return null;
}

function hasEmploymentLinkData(detail: unknown) {
	if (!isPlainObject(detail)) return false;
	const currentEmployments = Array.isArray((detail as Record<string, any>).currentEmployments) ? (detail as Record<string, any>).currentEmployments : [];
	const currentIAEmployments = Array.isArray((detail as Record<string, any>).currentIAEmployments) ? (detail as Record<string, any>).currentIAEmployments : [];
	const previousEmployments = Array.isArray((detail as Record<string, any>).previousEmployments) ? (detail as Record<string, any>).previousEmployments : [];
	const previousIAEmployments = Array.isArray((detail as Record<string, any>).previousIAEmployments) ? (detail as Record<string, any>).previousIAEmployments : [];
	return currentEmployments.length > 0 || currentIAEmployments.length > 0 || previousEmployments.length > 0 || previousIAEmployments.length > 0;
}

function indicatesFinraCoverage(detail: unknown) {
	if (!isPlainObject(detail)) return false;
	const basic = isPlainObject((detail as Record<string, any>).basicInformation) ? ((detail as Record<string, any>).basicInformation as Record<string, any>) : {};
	const bcScope = String((detail as Record<string, any>).bcScope ?? basic.bcScope ?? '')
		.trim()
		.toLowerCase();
	if (bcScope && bcScope !== 'notinscope') return true;

	const registrationCount = isPlainObject((detail as Record<string, any>).registrationCount) ? ((detail as Record<string, any>).registrationCount as Record<string, any>) : {};
	if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) return true;
	if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) return true;

	if (Array.isArray((detail as Record<string, any>).registeredSROs) && (detail as Record<string, any>).registeredSROs.length > 0) return true;
	if (isPlainObject((detail as Record<string, any>).brokerDetails)) return true;

	return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Scraped, non-live reference record (no FINRA/SEC detail available for this CRD).
function isOrphanIndividualPayload(data: unknown): data is { orphan: Record<string, any>; sources?: Record<string, any> } {
	if (!isPlainObject(data) || !isPlainObject((data as Record<string, any>).orphan)) return false;
	const sources = (data as Record<string, any>).sources;
	if (!isPlainObject(sources)) return false;
	const finraSource = sources.finra as Record<string, any> | undefined;
	const secSource = sources.sec as Record<string, any> | undefined;
	return finraSource?.found === false && secSource?.found === false;
}

function mergePreferPrimary(primary: unknown, secondary: unknown): unknown {
	if (primary == null || primary === '') return secondary;
	if (secondary == null || secondary === '') return primary;
	if (Array.isArray(primary) && Array.isArray(secondary)) {
		if (!primary.length) return secondary;
		if (!secondary.length) return primary;
		const seen = new Set(primary.map((item) => JSON.stringify(item)));
		return [
			...primary,
			...secondary.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(primary) && isPlainObject(secondary)) {
		const merged: Record<string, unknown> = { ...primary };
		for (const [key, value] of Object.entries(secondary)) {
			merged[key] = key in merged ? mergePreferPrimary(merged[key], value) : value;
		}
		return merged;
	}
	return primary;
}

function buildIndividualQueryParams(searchParams: URLSearchParams) {
	const params = new URLSearchParams();
	for (const [key, value] of searchParams.entries()) {
		if (!value) continue;
		if (key === 'includesPrevious' && !searchParams.has('includePrevious')) {
			params.set('includePrevious', value);
			continue;
		}
		params.set(key, value);
	}
	if (!params.has('hl')) params.set('hl', 'true');
	if (!params.has('wt')) params.set('wt', 'json');
	if (!params.has('includePrevious')) params.set('includePrevious', 'true');
	params.delete('nrows');
	return params;
}

// determine whether parsed details contain a usable numeric identifier
function findNumericId(obj: any, candidates: string[]) {
	if (!obj || typeof obj !== 'object') return '';
	for (const key of candidates) {
		const v = obj[key];
		if (v == null) continue;
		const s = String(v).trim();
		if (/^\d+$/.test(s)) return s;
		if (/^8-\d+$/i.test(s)) return s;
	}
	// try nested basicInformation
	const bi = obj.basicInformation || obj.basic_information || obj.basic || null;
	if (bi && typeof bi === 'object') {
		for (const key of candidates) {
			const v = bi[key];
			if (v == null) continue;
			const s = String(v).trim();
			if (/^\d+$/.test(s)) return s;
			if (/^8-\d+$/i.test(s)) return s;
		}
	}
	return '';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ crd: string }> }) {
	const { crd } = await params;
	if (!/^\d{1,10}$/.test(crd)) {
		return NextResponse.json({ error: 'Invalid CRD number.' }, { status: 400 });
	}
	const crdNorm = ensurePersonCrd(crd);
	const isMergedRoute = request.nextUrl.searchParams.get('merged') === '1';
	const forceRefresh = request.nextUrl.searchParams.get('forceRefresh') === '1';
	const writeRequested = request.nextUrl.searchParams.get('write') === '1' || request.nextUrl.searchParams.get('refreshWrite') === '1';

	if (forceRefresh) {
		await Promise.allSettled([evictCacheKey(makeRedisKey('finra', 'individual', crdNorm)), evictCacheKey(makeRedisKey('sec', 'individual', crdNorm))]);
	}

	void rememberRecentSeed('individual', crd).catch((error) => {
		logger.warn('failed to remember recent individual seed', { crd, error: error?.message || String(error) });
	});

	try {
		const fetchQuery = 'hl=true&includePrevious=true&wt=json';
		const fetchOptions = {
			headers: {
				'Accept': 'application/json',
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Referer': 'https://brokercheck.finra.org/',
			},
			next: { revalidate: 1209600 },
		};

		// Track upstream fetch outcomes (esp. 429 rate-limiting) so callers can distinguish
		// "genuinely not found" from "temporarily unreachable" instead of both collapsing to
		// `found:false`. See scripts/check_internal_api_health.mjs for a diagnostic that relies
		// on this signal.
		const upstreamStatus: { finra: { rateLimited: boolean; retryAfterSec: number | null; httpStatus: number | null }; sec: { rateLimited: boolean; retryAfterSec: number | null; httpStatus: number | null } } = {
			finra: { rateLimited: false, retryAfterSec: null, httpStatus: null },
			sec: { rateLimited: false, retryAfterSec: null, httpStatus: null },
		};

		const requests = await Promise.allSettled([
			cachedFetch(makeRedisKey('finra', 'individual', crdNorm), 60 * 60 * 24, async () => {
				try {
					const url = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(url, fetchOptions);
					upstreamStatus.finra.httpStatus = res.status;
					if (res.status === 429) {
						upstreamStatus.finra.rateLimited = true;
						const retryAfter = res.headers.get('retry-after');
						upstreamStatus.finra.retryAfterSec = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
					}
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('FINRA external fetch failed', { crd, error: err.message });
					return undefined;
				}
			}),
			cachedFetch(makeRedisKey('sec', 'individual', crdNorm), 60 * 60 * 24, async () => {
				try {
					const url = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(url, fetchOptions);
					upstreamStatus.sec.httpStatus = res.status;
					if (res.status === 429) {
						upstreamStatus.sec.rateLimited = true;
						const retryAfter = res.headers.get('retry-after');
						upstreamStatus.sec.retryAfterSec = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
					}
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				} catch (err: any) {
					logger.warn('SEC external fetch failed', { crd, error: err.message });
					return undefined;
				}
			}),
		]);

		const finraData = requests[0].status === 'fulfilled' ? requests[0].value : null;
		const secData = requests[1].status === 'fulfilled' ? requests[1].value : null;

		const anyRateLimited = upstreamStatus.finra.rateLimited || upstreamStatus.sec.rateLimited;
		const rateLimitedRetryAfterSec = Math.max(upstreamStatus.finra.retryAfterSec || 0, upstreamStatus.sec.retryAfterSec || 0) || null;

		function isPoorIndividualPayload(detail: any, raw: any) {
			// Null parsing => poor
			if (!detail) return true;
			// Missing any name and no numeric id and no employment links => poor
			const numeric = findNumericId(detail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']);
			const hasName = Boolean(detail.firstName || detail.lastName || detail.personName || detail.displayName);
			const hasEmployment = hasEmploymentLinkData(detail);
			if (!numeric && !hasName && !hasEmployment) return true;
			// Otherwise assume OK
			return false;
		}

		// Scraped-only reference record: no live FINRA/SEC detail, surface the orphan metadata as-is.
		if (isOrphanIndividualPayload(finraData) || isOrphanIndividualPayload(secData)) {
			const orphanPayload = isOrphanIndividualPayload(finraData) ? finraData : secData;
			return NextResponse.json(
				{ found: true, crd, orphan: orphanPayload.orphan, sources: orphanPayload.sources, hasFinraData: false, hasSecData: false },
				{ headers: sharedCacheHeaders(1209600) },
			);
		}

		let finraDetail = parseDetailPayload(finraData, 'content');
		const secDetail = parseDetailPayload(secData, 'iacontent');

		// Auto-heal: If Redis contained a payload but parsing produced poor data,
		// evict the bad key, fetch fresh from the external API, and optionally
		// persist when UPSTASH_ALLOW_WRITES=1 or caller requested `write=1`.
		if (isPoorIndividualPayload(finraDetail, finraData) && finraData) {
			try {
				logger.info('poor-data-detected-in-redis-key', { crd, key: makeRedisKey('finra', 'individual', crdNorm) });
				await evictCacheKey(makeRedisKey('finra', 'individual', crdNorm));
				if (canCallExternalApis()) {
					const finraUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(finraUrl, fetchOptions);
					if (res.ok) {
						const fresh = await res.json();
						const refreshed = parseDetailPayload(fresh, 'content');
						if (refreshed) {
							finraDetail = refreshed;
							logger.info('refreshed-poor-redis-key-from-external', { crd, key: makeRedisKey('finra', 'individual', crdNorm) });
							// push dashboard alert
							try {
								const redis = getRedisClientInstance({ url: process.env.UPSTASH_REDIS_REST_URL || '', token: process.env.UPSTASH_REDIS_REST_TOKEN || '' });
								if (redis) {
									await redis.lpush('dashboard:alerts', JSON.stringify({ at: new Date().toISOString(), id: crd, entity: 'individual', type: 'auto-heal', source: 'finra' }));
									await redis.ltrim('dashboard:alerts', 0, 999).catch(() => null);
								}
							} catch {}
							// auto-write when allowed or requested
							if (String(process.env.UPSTASH_ALLOW_WRITES || '').toLowerCase() === '1' || writeRequested) {
								try {
									await setStringIfValid(makeRedisKey('finra', 'individual', crdNorm), JSON.stringify(fresh), null);
								} catch {}
							}
						}
					}
				}
			} catch (e) {
				// ignore
			}
		}

		if (isPoorIndividualPayload(secDetail, secData) && secData) {
			try {
				logger.info('poor-data-detected-in-redis-key', { crd, key: makeRedisKey('sec', 'individual', crdNorm) });
				await evictCacheKey(makeRedisKey('sec', 'individual', crdNorm));
				if (canCallExternalApis()) {
					const secUrl = `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
					const res = await fetch(secUrl, fetchOptions);
					if (res.ok) {
						const fresh = await res.json();
						const refreshed = parseDetailPayload(fresh, 'iacontent');
						if (refreshed) {
							// set secDetail and optionally persist
							// Note: secDetail is const; we'll not reassign but use refreshed for merging
							logger.info('refreshed-poor-redis-key-from-external', { crd, key: makeRedisKey('sec', 'individual', crdNorm) });
							try {
								const redis = getRedisClientInstance({ url: process.env.UPSTASH_REDIS_REST_URL || '', token: process.env.UPSTASH_REDIS_REST_TOKEN || '' });
								if (redis) {
									await redis.lpush('dashboard:alerts', JSON.stringify({ at: new Date().toISOString(), id: crd, entity: 'individual', type: 'auto-heal', source: 'sec' }));
									await redis.ltrim('dashboard:alerts', 0, 999).catch(() => null);
								}
							} catch {}
							if (String(process.env.UPSTASH_ALLOW_WRITES || '').toLowerCase() === '1' || writeRequested) {
								try {
									await setStringIfValid(makeRedisKey('sec', 'individual', crdNorm), JSON.stringify(fresh), null);
								} catch {}
							}
						}
					}
				}
			} catch (e) {
				// ignore
			}
		}

		const shouldForceFinraRefetch = !finraDetail && secDetail && indicatesFinraCoverage(secDetail) && !hasEmploymentLinkData(secDetail);

		if (shouldForceFinraRefetch && canCallExternalApis()) {
			try {
				const finraUrl = `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?${fetchQuery}`;
				const directFinra = await fetch(finraUrl, fetchOptions);
				if (directFinra.ok) {
					const directPayload = await directFinra.json();
					const refreshed = parseDetailPayload(directPayload, 'content');
					if (refreshed) {
						finraDetail = refreshed;
					}
				}
			} catch (err: any) {
				logger.warn('individual route direct FINRA retry failed', { crd, error: err?.message || String(err) });
			}
		}

		if (!finraDetail && !secDetail) {
			// If FINRA/SEC search returns a hit but lacks a full detail profile (`content`),
			// construct an orphan from the search hit rather than falling back immediately.
			const finraSearchHit = finraData?.hits?.hits?.length ? finraData.hits.hits[0]._source : null;
			const secSearchHit = secData?.hits?.hits?.length ? secData.hits.hits[0]._source : null;
			const searchHit = finraSearchHit || secSearchHit;

			let orphan = null;
			if (searchHit) {
				orphan = {
					personId: crd,
					crdNumber: crd,
					name: [searchHit.ind_firstname, searchHit.ind_middlename, searchHit.ind_lastname].filter(Boolean).join(' ') || `Person ${crd}`,
					firstName: searchHit.ind_firstname || '',
					middleName: searchHit.ind_middlename || '',
					lastName: searchHit.ind_lastname || '',
					bcScope: searchHit.ind_bc_scope || searchHit.bcScope || 'NotInScope',
					iaScope: searchHit.iaScope || 'NotInScope',
				};
			} else {
				// Last resort: check the non-live CRD index
				orphan = await lookupOwnerReference(crd).catch(() => null);
			}

			if (orphan) {
				// Persist only for this CRD's detail page — never auto-index related search hits.
				void recordOwnerReference({
					crd: String(crd),
					name: typeof (orphan as any).name === 'string' ? (orphan as any).name : undefined,
					position: typeof (orphan as any).position === 'string' ? (orphan as any).position : undefined,
					firmName: typeof (orphan as any).firmName === 'string' ? (orphan as any).firmName : undefined,
					parentCrd: String((orphan as any).parentCrd || crd),
					parentType: (orphan as any).parentType === 'individual' ? 'individual' : 'firm',
					firmStatus: typeof (orphan as any).firmStatus === 'string' ? (orphan as any).firmStatus : undefined,
				}).catch((err: any) => {
					logger.warn('failed to persist non-live individual reference', { crd, error: err?.message || String(err) });
				});
				return NextResponse.json(
					{
						found: true,
						crd,
						orphan,
						sources: { finra: { found: false }, sec: { found: false } },
						hasFinraData: false,
						hasSecData: false,
					},
					{ headers: sharedCacheHeaders(1209600) },
				);
			}
			if (anyRateLimited) {
				const headers: Record<string, string> = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };
				if (rateLimitedRetryAfterSec) headers['Retry-After'] = String(rateLimitedRetryAfterSec);
				return NextResponse.json({ found: false, crd, rateLimited: true, retryAfterSec: rateLimitedRetryAfterSec }, { status: 429, headers });
			}
			return NextResponse.json({ found: false, crd }, { status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } });
		}

		const detail: any =
			finraDetail ?
				secDetail ? mergePreferPrimary(secDetail, finraDetail)
				:	finraDetail
			:	secDetail;

		if (!isPlainObject(detail)) {
			logger.warn('parsed individual detail is not an object', { crd, type: typeof detail });
			return NextResponse.json(
				{ found: false, crd, error: 'invalid-detail-shape' },
				{ status: 200, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
			);
		}

		const finraNumeric = finraDetail ? findNumericId(finraDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';
		const secNumeric = secDetail ? findNumericId(secDetail, ['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id']) : '';

		detail.hasFinraData = !!finraDetail && !!finraNumeric && hasIndividualSourceCoverage(finraDetail, 'finra');
		detail.hasSecData = !!secDetail && !!secNumeric && hasIndividualSourceCoverage(secDetail, 'sec');
		if (detail.hasFinraData || detail.hasSecData) {
			void rememberInventoryEntities([{ kind: 'individual', id: crd }]).catch((err: any) => {
				logger.warn('failed to update inventory sidecar for individual', { crd, error: err?.message || String(err) });
			});
		}

		// Queue background hydration of the external API to ensure cache stays hydrated
		queueHydration('individual', crd);

		// Do not auto-create non-live-crds for employer firms discovered in employment history.
		// Those keys are only written when that firm's own detail page resolves as non-live.
		{
			const bi: any = detail.basicInformation || {};
			const individualName = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' ');
			const employerLinks = extractIndividualEmployerLinksFromDetail(detail);
			const logEntries: Array<{ kind: 'firm' | 'individual'; id: string | number; name?: string }> = [
				{ kind: 'individual', id: crd, name: individualName },
				...employerLinks.map((link) => ({
					kind: 'firm' as const,
					id: link.firmId,
					name: link.firmName,
				})),
			];
			void rememberCrdLogEntries(logEntries).catch((err: any) => {
				logger.warn('failed to record firm reference index for individual', {
					crd,
					error: err?.message || String(err),
				});
			});

			if (employerLinks.length && canWriteToRedis()) {
				// Page-load upsert only when writes are allowed and Redis is usable.
				// Fire-and-forget so TTFB stays low; skip-unchanged keeps repeat views cheap.
				void upsertIndividualIntoEmployerFirmConnections(crd, detail, {
					skipUnchanged: true,
					maxFirmWrites: 40,
					evidenceTag: 'individual-detail-load',
				}).catch((err: any) => {
					logger.warn('failed to upsert individual into employer firm-connections', {
						crd,
						error: err?.message || String(err),
					});
				});
			}
		}

		if (isMergedRoute) {
			return NextResponse.json(
				{
					crd,
					found: true,
					hasFinraData: detail.hasFinraData,
					hasSecData: detail.hasSecData,
					finraNode: detail,
					sources: {
						finra: finraDetail ? { bccontent: finraDetail } : null,
						sec: secDetail ? { iacontent: secDetail } : null,
					},
					merged: detail,
				},
				{ headers: sharedCacheHeaders(1209600) },
			);
		}

		const searchIndexDetail = normalizeIndividualDetailFromSource(detail, crd);
		try {
			await addRecordToSearchIndex('finra', 'individual', crd, searchIndexDetail);
		} catch (searchIndexErr: any) {
			logger.warn('failed to update local individual search index from detail route', { crd, error: searchIndexErr?.message || String(searchIndexErr) });
		}

		const responseData: any = { found: true, crd };
		if (finraDetail) responseData.bccontent = finraDetail;
		if (secDetail) responseData.iacontent = secDetail;

		return NextResponse.json(responseData, { headers: sharedCacheHeaders(1209600) });
	} catch (err: any) {
		logger.error('individual local detail route error', {
			crd,
			error: err.message,
			stack: err.stack,
		});
		return NextResponse.json(
			{
				error: 'Failed to load individual detail.',
				message: err.message,
				crd,
			},
			{ status: 500 },
		);
	}
}
