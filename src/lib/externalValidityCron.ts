import type { Redis } from '@upstash/redis';
import axios from 'axios';
import { getRedisClientInstance } from '@/lib/redisClient';
import { saveGraph, getFullGraph } from '@/lib/graphStore';
import { getSeedBankFromStore } from '@/lib/graphStore';
import { DEFAULT_HEADERS } from '@/lib/requestConstants';
import { randomUUID } from 'crypto';

const STATE_KEY = 'finra:cron:external-validity:state';
const MONITOR_KEY = 'finra:redis-monitor';
const LOCK_KEY = 'finra:cron:external-validity:lock';
const DEFAULT_LOCK_TTL_SECONDS = Math.max(30, Number(process.env.FINRA_EXTERNAL_VALIDITY_CRON_LOCK_TTL_SECONDS || 300));
// If true, use TTL-only locking (don't attempt to delete the lock at the end)
const USE_TTL_ONLY_LOCK = String(process.env.FINRA_EXTERNAL_VALIDITY_CRON_TTL_ONLY || 'false').toLowerCase() === 'true';
const QUEUE_KEY = 'finra:cron:queue';
const PROCESSED_SET = 'finra:cron:processed';
const RETRY_ZSET = 'finra:cron:retry';
const PENDING_PREFIX = 'finra:pending';
const DEFAULT_RETRY_SECONDS = Math.max(60, Number(process.env.FINRA_EXTERNAL_VALIDITY_RETRY_SECONDS || 300));
const INDIVIDUAL_QUERY = new URLSearchParams({ hl: 'true', includePrevious: 'true', wt: 'json' }).toString();
const FIRM_QUERY = new URLSearchParams({ hl: 'true', wt: 'json' }).toString();

const DEFAULT_DISCOVERY_BATCH = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_DISCOVERY_BATCH || 3));
const DEFAULT_UPDATE_BATCH = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_UPDATE_BATCH || 3));
const DEFAULT_FAILBACK_MINUTES = [6, 11] as const;
const DEFAULT_MIN_RUN_INTERVAL_MINUTES = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_MIN_RUN_INTERVAL_MINUTES || 360));

type CronState = {
	backoffUntil: number;
	discovery: {
		individualNext: number;
		firmNext: number;
	};
	updateIndex: {
		individual: number;
		firm: number;
	};
	updatedAt: string;
	lastRunAt: string | null;
};

type RunSummary = {
	processed: number;
	discovered: number;
	updated: number;
	skippedNoData: number;
	backoffUntil: number;
	reason?: string;
	state: CronState;
};

type DetailPayload = Record<string, any> | null;

function normalizeId(value: unknown) {
	return String(value || '')
		.trim()
		.replace(/^person[:_]/i, '')
		.replace(/^firm[:_]/i, '');
}

function isNumericId(value: unknown) {
	return /^\d+$/.test(normalizeId(value));
}

function numericSortDesc(left: string, right: string) {
	return Number(right) - Number(left);
}

function uniqueSortedNumericIds(values: unknown[]) {
	return Array.from(new Set(values.map(normalizeId).filter(isNumericId))).sort(numericSortDesc);
}

export function extractCandidateIdsFromSearchPayload(payload: any, kind: 'individual' | 'firm') {
	const ids = new Set<string>();
	const hits = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];

	for (const hit of hits) {
		const source = hit?._source || {};
		const parsedContent = (() => {
			if (!source.content) return null;
			try {
				return typeof source.content === 'string' ? JSON.parse(source.content) : source.content;
			} catch {
				return null;
			}
		})();

		if (kind === 'individual') {
			const directId = source.ind_source_id || source.person?.crd || parsedContent?.basicInformation?.crd || parsedContent?.basicInformation?.individualId;
			if (directId) ids.add(String(directId));
		} else {
			const directId = source.firm_id || source.firmId || source.firm_bd_sec_number || parsedContent?.basicInformation?.firmId || parsedContent?.basicInformation?.bdSECNumber;
			if (directId) ids.add(String(directId));
		}
	}

	return uniqueSortedNumericIds(Array.from(ids));
}

function normalizeDiscoveryTerm(value: string) {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

export function buildNameQueryCandidates(seedBank: {
	individualIds?: string[];
	firmIds?: string[];
	nameByNumber?: { individual?: Record<string, string>; firm?: Record<string, string> };
}) {
	const terms = new Set<string>();

	const seedNames = [
		...(seedBank?.individualIds || []),
		...(seedBank?.firmIds || []),
		...Object.values(seedBank?.nameByNumber?.individual || {}),
		...Object.values(seedBank?.nameByNumber?.firm || {}),
	];

	for (const raw of seedNames) {
		const words = normalizeDiscoveryTerm(String(raw || ''));
		for (const word of words) {
			if (word.length >= 3 && word.length <= 10) terms.add(word);
			for (let start = 0; start < word.length - 2; start += 1) {
				for (let end = start + 3; end <= Math.min(word.length, 10); end += 1) {
					terms.add(word.slice(start, end));
				}
			}
		}
		const joined = words.join(' ');
		if (joined.length >= 3 && joined.length <= 10) terms.add(joined);
	}

	return Array.from(terms)
		.filter((term) => term.length >= 3 && term.length <= 10)
		.sort((a, b) => a.localeCompare(b));
}

function maxNumericId(values: string[]) {
	if (!values.length) return 0;
	return Math.max(...values.map((v) => Number(v)).filter((n) => Number.isFinite(n)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergePreferPatch(base: unknown, patch: unknown): unknown {
	if (patch == null || patch === '') return base;
	if (base == null || base === '') return patch;
	if (Array.isArray(base) && Array.isArray(patch)) {
		if (!patch.length) return base;
		if (!base.length) return patch;
		const seen = new Set(base.map((item) => JSON.stringify(item)));
		return [
			...base,
			...patch.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		];
	}
	if (isPlainObject(base) && isPlainObject(patch)) {
		const merged: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(patch)) {
			merged[key] = key in merged ? mergePreferPatch(merged[key], value) : value;
		}
		return merged;
	}
	return patch;
}

function parseDetailPayload(data: any, contentKey = 'content') {
	if (!data) return null;
	if (data?.hits?.hits?.length) {
		const raw = data.hits.hits[0]?._source?.[contentKey];
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
		}
	}

	const raw = data?.[contentKey];
	if (raw != null) {
		try {
			return typeof raw === 'string' ? JSON.parse(raw) : raw || null;
		} catch {
			return null;
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
			data.firmStatus ||
			data.disclosures ||
			data.currentEmployments ||
			data.previousEmployments ||
			data.directOwners;
		if (looksLikeDetail) return data;
	}

	return null;
}

function getAuthHeaders() {
	return { Accept: 'application/json', ...DEFAULT_HEADERS };
}

async function fetchUpstreamJson(url: string) {
	let domain = 'unknown';
	let crds: string[] = [];
	try {
		const parsedUrl = new URL(url);
		domain = parsedUrl.hostname;
		const pathParts = parsedUrl.pathname.split('/');
		const lastPart = pathParts[pathParts.length - 1];
		if (/^\d+$/.test(lastPart) || /^8-\d+$/i.test(lastPart)) {
			crds.push(lastPart);
		} else {
			const queryParam = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('q');
			if (queryParam) {
				const matches = queryParam.match(/\b\d{1,10}\b/g) || [];
				crds.push(...matches);
			}
		}
	} catch {
		// ignore
	}

	console.log(`[External API Access] Time: ${new Date().toISOString()} | Accessing external API: ${url} | Domain: ${domain} | CRDs: [${crds.join(', ')}] | Count: ${crds.length}`);

	const response = await axios.get(url, {
		headers: getAuthHeaders(),
		timeout: 15000,
		validateStatus: () => true,
	});
	if (response.status === 429) {
		const error = new Error(`HTTP 429 for ${url}`);
		(error as any).status = 429;
		throw error;
	}
	if (response.status === 404) return null;
	if (response.status >= 400) {
		const error = new Error(`HTTP ${response.status} for ${url}`);
		(error as any).status = response.status;
		throw error;
	}
	return response.data;
}

async function fetchSearchCandidates(kind: 'individual' | 'firm', query: string) {
	const normalized = String(query || '').trim();
	if (!normalized) return [];

	const finraUrl =
		kind === 'individual' ?
			`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(normalized)}?hl=true&includePrevious=true&nrows=12&wt=json`
		:	`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(normalized)}?hl=true&nrows=12&wt=json`;
	const secUrl =
		kind === 'individual' ?
			`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(normalized)}?hl=true&includePrevious=true&nrows=12&wt=json`
		:	`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(normalized)}?hl=true&nrows=12&wt=json`;

	const [finra, sec] = await Promise.all([fetchUpstreamJson(finraUrl), fetchUpstreamJson(secUrl)]);
	return [...extractCandidateIdsFromSearchPayload(finra, kind), ...extractCandidateIdsFromSearchPayload(sec, kind)];
}

async function fetchRecord(kind: 'individual' | 'firm', id: string) {
	const normalized = normalizeId(id);
	if (!isNumericId(normalized)) return { finra: null, sec: null };
	const finraUrl =
		kind === 'individual' ?
			`https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(normalized)}?${INDIVIDUAL_QUERY}`
		:	`https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(normalized)}?${FIRM_QUERY}`;
	const secUrl =
		kind === 'individual' ?
			`https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(normalized)}?wt=json`
		:	`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(normalized)}?wt=json`;
	const [finra, sec] = await Promise.all([fetchUpstreamJson(finraUrl), fetchUpstreamJson(secUrl)]);
	return {
		finra: parseDetailPayload(finra, 'content'),
		sec: parseDetailPayload(sec, 'iacontent'),
	};
}

function getDisplayName(kind: 'individual' | 'firm', detail: any, id: string) {
	const basic = detail?.basicInformation || {};
	if (kind === 'individual') {
		return [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') || detail?.name || `CRD ${id}`;
	}
	return basic.firmName || detail?.firmName || detail?.name || `Firm ${id}`;
}

function buildRecordNode(kind: 'individual' | 'firm', id: string, finra: any, sec: any) {
	const merged =
		finra ?
			sec ? mergePreferPatch(finra, sec)
			:	finra
		:	sec;
	if (!merged) return null;
	const basic = merged.basicInformation || {};
	const nodeId = kind === 'individual' ? `person:${normalizeId(id)}` : `firm:${normalizeId(id)}`;
	const node: any = {
		id: nodeId,
		label: getDisplayName(kind, merged, normalizeId(id)),
		group: kind === 'individual' ? 'individual' : 'firm',
		_source: 'external-validity-cron',
		lastCheckedAt: new Date().toISOString(),
		hasFinraData: Boolean(finra),
		hasSecData: Boolean(sec),
		basicInformation: merged.basicInformation || basic,
		crd: kind === 'individual' ? normalizeId(id) : undefined,
		firmId: kind === 'firm' ? normalizeId(id) : undefined,
	};

	if (kind === 'individual') {
		node.bcScope = merged.bcScope ?? basic.bcScope ?? null;
		node.iaScope = merged.iaScope ?? basic.iaScope ?? null;
		node.disclosures = merged.disclosures ?? null;
		node.currentEmployments =
			Array.isArray(merged.currentEmployments) ? merged.currentEmployments
			: Array.isArray(merged.ind_current_employments) ? merged.ind_current_employments
			: [];
		node.currentIAEmployments =
			Array.isArray(merged.currentIAEmployments) ? merged.currentIAEmployments
			: Array.isArray(merged.ind_ia_current_employments) ? merged.ind_ia_current_employments
			: [];
	} else {
		node.bcScope = merged.bcScope ?? basic.bcScope ?? null;
		node.iaScope = merged.iaScope ?? basic.iaScope ?? null;
		node.firmStatus = merged.firmStatus ?? basic.firmStatus ?? null;
		node.firmStatusDate = merged.firmStatusDate ?? basic.firmStatusDate ?? null;
		node.directOwners = Array.isArray(merged.directOwners) ? merged.directOwners : [];
		node.disclosures = merged.disclosures ?? [];
	}

	return node;
}

function addEmploymentLinks(node: any, merged: any, existingNodes: Map<string, any>) {
	const links: any[] = [];
	const employments = [
		...(Array.isArray(merged?.currentEmployments) ? merged.currentEmployments : []),
		...(Array.isArray(merged?.ind_current_employments) ? merged.ind_current_employments : []),
		...(Array.isArray(merged?.currentIAEmployments) ? merged.currentIAEmployments : []),
		...(Array.isArray(merged?.ind_ia_current_employments) ? merged.ind_ia_current_employments : []),
	];

	for (const employment of employments) {
		const firmId = normalizeId(employment?.firm_id || employment?.firmId || employment?.firm_source_id || '');
		if (!isNumericId(firmId)) continue;
		const firmNodeId = `firm:${firmId}`;
		if (!existingNodes.has(firmNodeId)) {
			existingNodes.set(firmNodeId, {
				id: firmNodeId,
				label: employment?.firm_name || employment?.firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId,
				_source: 'external-validity-cron',
				stub: true,
			});
		}
		links.push({ source: node.id, target: firmNodeId, relationship: 'employed_by', isCurrent: true });
	}

	return links;
}

function snapshotRecordForComparison(node: any) {
	return {
		id: String(node?.id || ''),
		label: String(node?.label || ''),
		group: node?.group,
		basicInformation: node?.basicInformation || null,
		bcScope: node?.bcScope ?? null,
		iaScope: node?.iaScope ?? null,
		firmStatus: node?.firmStatus ?? null,
		firmStatusDate: node?.firmStatusDate ?? null,
		disclosures: node?.disclosures ?? null,
		currentEmployments: node?.currentEmployments ?? null,
		currentIAEmployments: node?.currentIAEmployments ?? null,
		directOwners: node?.directOwners ?? null,
	};
}

function hasRecordChanged(graph: any, node: any) {
	const current = Array.isArray(graph?.nodes) ? graph.nodes.find((entry: any) => String(entry?.id || '') === String(node?.id || '')) : null;
	return JSON.stringify(snapshotRecordForComparison(current)) !== JSON.stringify(snapshotRecordForComparison(node));
}

function mergeIntoGraph(graph: any, node: any, links: any[]) {
	const nodeMap = new Map<string, any>();
	for (const existing of Array.isArray(graph?.nodes) ? graph.nodes : []) {
		const id = String(existing?.id || '').trim();
		if (id) nodeMap.set(id, existing);
	}

	const current = nodeMap.get(node.id);
	if (current) {
		nodeMap.set(node.id, mergePreferPatch(current, node) as any);
	} else {
		nodeMap.set(node.id, node);
	}

	const extraNodes = (links as any)._extraNodes || [];
	for (const extraNode of extraNodes) {
		if (!nodeMap.has(extraNode.id)) nodeMap.set(extraNode.id, extraNode);
		else nodeMap.set(extraNode.id, mergePreferPatch(nodeMap.get(extraNode.id), extraNode) as any);
	}

	const mergedNodes = Array.from(nodeMap.values());
	const linkKey = (link: any) => `${String(link?.source?.id ?? link?.source ?? '')}|${String(link?.target?.id ?? link?.target ?? '')}|${String(link?.relationship || '')}`;
	const existingLinks = new Set((Array.isArray(graph?.links) ? graph.links : []).map(linkKey));
	const mergedLinks = [...(Array.isArray(graph?.links) ? graph.links : [])];
	for (const link of links as any[]) {
		if (existingLinks.has(linkKey(link))) continue;
		mergedLinks.push(link);
	}

	const meta = {
		...(graph?.meta || {}),
		generated: new Date().toISOString(),
		externalValidityCheckedAt: new Date().toISOString(),
	};

	return { nodes: mergedNodes, links: mergedLinks, meta };
}

function createDefaultState(maxIndividual: number, maxFirm: number): CronState {
	return {
		backoffUntil: 0,
		discovery: {
			individualNext: maxIndividual + 1,
			firmNext: maxFirm + 1,
		},
		updateIndex: {
			individual: maxIndividual,
			firm: maxFirm,
		},
		updatedAt: new Date().toISOString(),
		lastRunAt: null,
	};
}

function normalizeState(raw: unknown, maxIndividual: number, maxFirm: number): CronState {
	const fallback = createDefaultState(maxIndividual, maxFirm);
	if (!raw || typeof raw !== 'object') return fallback;
	const candidate = raw as Partial<CronState>;
	return {
		backoffUntil: Math.max(0, Number(candidate.backoffUntil || 0)),
		discovery: {
			individualNext: Math.max(maxIndividual + 1, Number(candidate.discovery?.individualNext || fallback.discovery.individualNext)),
			firmNext: Math.max(maxFirm + 1, Number(candidate.discovery?.firmNext || fallback.discovery.firmNext)),
		},
		updateIndex: {
			individual: (() => {
				const raw = Number(candidate.updateIndex?.individual);
				if (!Number.isFinite(raw) || raw <= 0) return fallback.updateIndex.individual;
				return Math.max(0, Math.min(maxIndividual || 0, raw));
			})(),
			firm: (() => {
				const raw = Number(candidate.updateIndex?.firm);
				if (!Number.isFinite(raw) || raw <= 0) return fallback.updateIndex.firm;
				return Math.max(0, Math.min(maxFirm || 0, raw));
			})(),
		},
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
		lastRunAt: typeof candidate.lastRunAt === 'string' ? candidate.lastRunAt : null,
	};
}

function getRedisClient() {
	// prefer MIRROR env var but fall back to legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	return url && token ? getRedisClientInstance({ url, token }) : null;
}

async function acquireLock(redis: Redis, ttlSeconds = DEFAULT_LOCK_TTL_SECONDS) {
	const token = randomUUID?.() || `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
	try {
		// set with NX and EX so only one cron runner can own the lock
		const ok = await redis.set(LOCK_KEY, token, { nx: true, ex: ttlSeconds });
		if (ok) return { acquired: true, token };
		return { acquired: false, token: null };
	} catch (e) {
		// if Redis is unavailable, avoid running concurrently — signal lock not acquired
		return { acquired: false, token: null };
	}
}

async function releaseLock(redis: Redis, token: string | null) {
	if (!token) return;
	if (USE_TTL_ONLY_LOCK) return; // leave expiration to TTL-only strategy
	try {
		// Best-effort safe delete: only delete if our token still matches.
		const current = await redis.get<string>(LOCK_KEY);
		if (current && String(current) === String(token)) {
			try {
				await redis.del(LOCK_KEY);
			} catch {
				// ignore delete failures
			}
		}
	} catch {
		// ignore
	}
}

function chooseBackoffUntil(now: number) {
	const minutes = DEFAULT_FAILBACK_MINUTES[0] + Math.floor(Math.random() * (DEFAULT_FAILBACK_MINUTES[1] - DEFAULT_FAILBACK_MINUTES[0] + 1));
	return now + minutes * 60 * 1000;
}

async function storeState(redis: Redis, state: CronState) {
	await redis.set(STATE_KEY, JSON.stringify(state), { ex: 60 * 60 * 24 * 30 });
}

async function moveDueRetriesToQueue(redis: Redis, now = Date.now(), limit = 100) {
	try {
		// get due members
		const due = (await (redis as any).zrangebyscore?.(RETRY_ZSET, '-inf', String(now))) || [];
		if (!due || !due.length) return 0;
		const slice = due.slice(0, limit);
		for (const member of slice) {
			try {
				await (redis as any).zrem?.(RETRY_ZSET, member);
			} catch {}
			try {
				await redis.lpush(QUEUE_KEY, member);
			} catch {}
		}
		return slice.length;
	} catch {
		return 0;
	}
}

async function enqueueCandidate(redis: Redis, kind: 'individual' | 'firm', id: string, source: 'discovery' | 'update') {
	const item = `${source}|${kind}:${String(id)}`;
	try {
		// if already processed, skip
		const processed = await (redis as any).sismember?.(PROCESSED_SET, `${kind}:${String(id)}`);
		if (processed) return false;
		await redis.lpush(QUEUE_KEY, item);
		return true;
	} catch {
		// best-effort: if enqueue fails, ignore
		return false;
	}
}

async function popQueueBatch(redis: Redis, limit: number) {
	const items: string[] = [];
	for (let i = 0; i < limit; i++) {
		try {
			const v = await (redis as any).rpop?.(QUEUE_KEY);
			if (!v) break;
			items.push(String(v));
		} catch {
			break;
		}
	}
	return items;
}

async function loadState(redis: Redis, maxIndividual: number, maxFirm: number): Promise<CronState> {
	try {
		const raw = await redis.get<string>(STATE_KEY);
		if (!raw) return createDefaultState(maxIndividual, maxFirm);
		return normalizeState(typeof raw === 'string' ? JSON.parse(raw) : raw, maxIndividual, maxFirm);
	} catch {
		return createDefaultState(maxIndividual, maxFirm);
	}
}

async function scheduleRetry(redis: Redis, kind: 'individual' | 'firm', id: string, delaySeconds = DEFAULT_RETRY_SECONDS) {
	try {
		const member = `${kind}:${normalizeId(id)}`;
		const score = Date.now() + Math.max(0, Number(delaySeconds)) * 1000;
		await (redis as any).zadd?.(RETRY_ZSET, score, member);
	} catch {
		// ignore
	}
}

async function isProcessed(redis: Redis, kind: 'individual' | 'firm', id: string) {
	try {
		const member = `${kind}:${normalizeId(id)}`;
		const res = await (redis as any).sismember?.(PROCESSED_SET, member as any);
		return Boolean(res);
	} catch {
		return false;
	}
}

async function markProcessed(redis: Redis, kind: 'individual' | 'firm', id: string) {
	try {
		const member = `${kind}:${normalizeId(id)}`;
		await (redis as any).sadd?.(PROCESSED_SET, member as any);
		// keep processed set bounded
		try {
			await (redis as any).expire?.(PROCESSED_SET, 60 * 60 * 24 * 30);
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

function buildDiscoveryCandidates(nextValue: number, batchSize: number) {
	return Array.from({ length: batchSize }, (_, index) => String(nextValue + index));
}

function buildUpdateCandidates(idsDesc: string[], cursor: number, batchSize: number) {
	if (!idsDesc.length) return [] as string[];
	const threshold = Math.max(0, cursor);
	return idsDesc.filter((id) => Number(id) <= threshold).slice(0, batchSize);
}

function nextThreshold(ids: string[], picked: number) {
	if (!picked || !ids.length) return 0;
	const selected = ids.slice(0, picked);
	const lowestSelected = selected.length ? Math.min(...selected.map((id) => Number(id)).filter((n) => Number.isFinite(n))) : 0;
	return lowestSelected > 0 ? lowestSelected - 1 : 0;
}

export function shouldSkipCronRun(lastRunAt: string | null | undefined, now = Date.now(), minIntervalMinutes = DEFAULT_MIN_RUN_INTERVAL_MINUTES) {
	const lastRunMs = Date.parse(String(lastRunAt || ''));
	if (!Number.isFinite(lastRunMs)) return false;
	return now - lastRunMs < Math.max(1, minIntervalMinutes) * 60 * 1000;
}

async function processCandidate(
	redis: Redis,
	graph: any,
	kind: 'individual' | 'firm',
	id: string,
): Promise<{ found: boolean; discovered: boolean; updated: boolean; 429: boolean }> {
	if (await isProcessed(redis, kind, id)) return { found: true, discovered: false, updated: false, 429: false };

	const graphNodeId = kind === 'individual' ? `person:${normalizeId(id)}` : `firm:${normalizeId(id)}`;
	const existingNode = graph?.nodes?.find((n: any) => n.id === graphNodeId || n.id === `${kind}:${normalizeId(id)}`);
	if (existingNode && existingNode.basicInformation) {
		const bcScope = String(existingNode.basicInformation.bcScope || '')
			.trim()
			.toLowerCase();
		const iaScope = String(existingNode.basicInformation.iaScope || '')
			.trim()
			.toLowerCase();
		if (bcScope !== 'active' && iaScope !== 'active') {
			await markProcessed(redis, kind, id);
			return { found: true, discovered: false, updated: false, 429: false };
		}
	}

	const { finra, sec } = await fetchRecord(kind, id);
	if (!finra && !sec) return { found: false, discovered: false, updated: false, 429: false };

	const node = buildRecordNode(kind, id, finra, sec);
	if (!node) return { found: false, discovered: false, updated: false, 429: false };

	if (!hasRecordChanged(graph, node)) {
		return { found: true, discovered: false, updated: false, 429: false };
	}

	// Persist raw payloads only if changed to save Redis command/bandwidth costs
	try {
		await redis.set(`${PENDING_PREFIX}:${kind}:${normalizeId(id)}:finra`, JSON.stringify(finra || {}));
	} catch {}
	try {
		await redis.set(`${PENDING_PREFIX}:${kind}:${normalizeId(id)}:sec`, JSON.stringify(sec || {}));
	} catch {}

	const linksAccumulator: any[] & { _extraNodes?: any[] } = [] as any;
	const tempNodes = new Map<string, any>();
	const extraLinks = addEmploymentLinks(node, node, tempNodes);
	linksAccumulator.push(...extraLinks);
	linksAccumulator._extraNodes = Array.from(tempNodes.values());

	const mergedGraph = mergeIntoGraph(graph, node, linksAccumulator);
	await saveGraph(mergedGraph);

	const domain = kind === 'individual' ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov';
	console.log(
		`[External API Access Success] Time: ${new Date().toISOString()} | Cron Synced and Added CRD | Domain: ${domain} | CRDs added: [${normalizeId(id)}] | Added count: 1`,
	);

	// refresh direct cache keys so the app reads the newest payloads on the next lookup
	try {
		const searchParams = kind === 'individual' ? INDIVIDUAL_QUERY : FIRM_QUERY;
		await redis.set(`${kind === 'individual' ? 'finra:individual' : 'finra:firm'}:${normalizeId(id)}:${searchParams}`, JSON.stringify(finra || sec), { ex: 60 * 60 * 24 });
		await redis.set(
			`${kind === 'individual' ? 'sec:individual' : 'sec:firm'}:${normalizeId(id)}:${kind === 'individual' ? INDIVIDUAL_QUERY : FIRM_QUERY}`,
			JSON.stringify(sec || finra),
			{ ex: 60 * 60 * 24 },
		);
	} catch {
		// best effort cache refresh only
	}

	// mark as processed so future runs skip
	try {
		await markProcessed(redis, kind, id);
	} catch {}

	return { found: true, discovered: true, updated: true, 429: false };
}

export async function runExternalValidityCron() {
	const redis = getRedisClient();
	if (!redis) {
		return { ok: false, error: 'Missing Upstash Redis configuration', processed: 0, discovered: 0, updated: 0, skippedNoData: 0 };
	}

	// Acquire a distributed lock so only one cron job runs at a time.
	const { acquired, token } = await acquireLock(redis, DEFAULT_LOCK_TTL_SECONDS);
	if (!acquired) {
		return { ok: true, skipped: true, reason: 'locked', processed: 0, discovered: 0, updated: 0, skippedNoData: 0 };
	}

	// ensure lock is released when function exits (best-effort)
	let lockToken: string | null = token;
	try {
		const graph = await getFullGraph();
		const seedBank = await getSeedBankFromStore();
		const individualIds = uniqueSortedNumericIds(seedBank?.individualIds || []);
		const firmIds = uniqueSortedNumericIds(seedBank?.firmIds || []);
		const discoveryTerms = buildNameQueryCandidates(seedBank);
		const discoveredNameIds = new Set<string>();

		for (const term of discoveryTerms) {
			try {
				for (const id of await fetchSearchCandidates('individual', term)) discoveredNameIds.add(id);
				for (const id of await fetchSearchCandidates('firm', term)) discoveredNameIds.add(id);
			} catch {
				// best effort: name-based discovery should not block the run
			}
		}

		const enrichedIndividuals = uniqueSortedNumericIds([...individualIds, ...discoveredNameIds]);
		const enrichedFirms = uniqueSortedNumericIds([...firmIds, ...discoveredNameIds]);
		const maxIndividual = maxNumericId(enrichedIndividuals);
		const maxFirm = maxNumericId(enrichedFirms);
		const state = await loadState(redis, maxIndividual, maxFirm);
		const now = Date.now();
		if (shouldSkipCronRun(state.lastRunAt, now)) {
			return {
				ok: true,
				skipped: true,
				reason: 'cooldown',
				resumeAt: Date.parse(String(state.lastRunAt || '')) + DEFAULT_MIN_RUN_INTERVAL_MINUTES * 60 * 1000,
				processed: 0,
				discovered: 0,
				updated: 0,
				skippedNoData: 0,
				state,
			};
		}
		if (state.backoffUntil && now < state.backoffUntil) {
			return { ok: true, skipped: true, reason: 'backoff', resumeAt: state.backoffUntil, processed: 0, discovered: 0, updated: 0, skippedNoData: 0, state };
		}

		const discoveryBatch = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_DISCOVERY_BATCH || DEFAULT_DISCOVERY_BATCH));
		const updateBatch = Math.max(1, Number(process.env.FINRA_EXTERNAL_VALIDITY_UPDATE_BATCH || DEFAULT_UPDATE_BATCH));
		let nextState: CronState = {
			...state,
			lastRunAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// Move any due retry items back into the work queue before processing
		try {
			await moveDueRetriesToQueue(redis);
		} catch {
			// ignore
		}

		const summary: RunSummary = {
			processed: 0,
			discovered: 0,
			updated: 0,
			skippedNoData: 0,
			backoffUntil: 0,
			state: nextState,
		};

		const handle429 = async () => {
			nextState.backoffUntil = chooseBackoffUntil(Date.now());
			nextState.updatedAt = new Date().toISOString();
			summary.backoffUntil = nextState.backoffUntil;
			await storeState(redis, nextState);
			return { ok: true, rateLimited: true, ...summary, state: nextState };
		};

		const processList = async (kind: 'individual' | 'firm', ids: string[], isDiscovery: boolean) => {
			for (const id of ids) {
				// persist candidate in queue for durability
				try {
					await redis.lpush(QUEUE_KEY, `${kind}:${normalizeId(id)}`);
				} catch {
					// ignore
				}

				// skip if already processed
				try {
					if (await isProcessed(redis, kind, id)) {
						continue;
					}
				} catch {
					// ignore and attempt processing
				}
				try {
					const result = await processCandidate(redis, graph, kind, id);
					summary.processed += 1;
					if (result.found) {
						summary.updated += 1;
						if (isDiscovery) summary.discovered += 1;
					}
					if (kind === 'individual') {
						if (isDiscovery) nextState.discovery.individualNext = Number(id) + 1;
						else nextState.updateIndex.individual = Math.max(Number(process.env.FINRA_EXTERNAL_VALIDITY_MIN_INDIVIDUAL_UPDATE || 7000000), Number(id) - 1);
					} else {
						if (isDiscovery) nextState.discovery.firmNext = Number(id) + 1;
						else nextState.updateIndex.firm = Math.max(Number(process.env.FINRA_EXTERNAL_VALIDITY_MIN_FIRM_UPDATE || 300000), Number(id) - 1);
					}
					await storeState(redis, nextState);
				} catch (error: any) {
					if (Number(error?.status || error?.response?.status) === 429) {
						// schedule retry for this ID and backoff overall
						try {
							await scheduleRetry(redis, kind, id, DEFAULT_RETRY_SECONDS);
						} catch {}
						return await handle429();
					}
					// on other failures schedule a retry
					try {
						await scheduleRetry(redis, kind, id, DEFAULT_RETRY_SECONDS);
					} catch {}
					summary.processed += 1;
					summary.skippedNoData += 1;
					if (kind === 'individual') {
						if (isDiscovery) nextState.discovery.individualNext = Number(id) + 1;
						else nextState.updateIndex.individual = Math.max(Number(process.env.FINRA_EXTERNAL_VALIDITY_MIN_INDIVIDUAL_UPDATE || 7000000), Number(id) - 1);
					} else {
						if (isDiscovery) nextState.discovery.firmNext = Number(id) + 1;
						else nextState.updateIndex.firm = Math.max(Number(process.env.FINRA_EXTERNAL_VALIDITY_MIN_FIRM_UPDATE || 300000), Number(id) - 1);
					}
					await storeState(redis, nextState);
				}
			}
			return null;
		};

		// 1) Discover higher-number CRDs first.
		const discoveryIndividuals = buildDiscoveryCandidates(Math.max(state.discovery.individualNext, maxIndividual + 1), discoveryBatch);
		const discoveryFirms = buildDiscoveryCandidates(Math.max(state.discovery.firmNext, maxFirm + 1), discoveryBatch);
		let result = await processList('individual', discoveryIndividuals, true);
		if (result) return result;
		result = await processList('firm', discoveryFirms, true);
		if (result) return result;

		// 2) Backfill existing CRDs from high to low.
		const descendingIndividuals = [...enrichedIndividuals].sort(numericSortDesc);
		const descendingFirms = [...enrichedFirms].sort(numericSortDesc);
		const updateIndividuals = buildUpdateCandidates(descendingIndividuals, state.updateIndex.individual, updateBatch);
		const updateFirms = buildUpdateCandidates(descendingFirms, state.updateIndex.firm, updateBatch);
		result = await processList('individual', updateIndividuals, false);
		if (result) return result;
		result = await processList('firm', updateFirms, false);
		if (result) return result;

		nextState.updateIndex.individual = nextThreshold(updateIndividuals, updateIndividuals.length);
		nextState.updateIndex.firm = nextThreshold(updateFirms, updateFirms.length);
		nextState.updatedAt = new Date().toISOString();
		await storeState(redis, nextState);

		try {
			await redis.lpush(
				MONITOR_KEY,
				JSON.stringify({
					ts: new Date().toISOString(),
					action: 'external-validity-cron',
					processed: summary.processed,
					discovered: summary.discovered,
					updated: summary.updated,
					backoffUntil: nextState.backoffUntil,
					state: nextState,
				}),
			);
			await redis.ltrim(MONITOR_KEY, 0, 199);
		} catch {
			// ignore monitoring errors
		}

		return { ok: true, ...summary, state: nextState };
	} finally {
		try {
			await releaseLock(redis, lockToken);
		} catch {
			// ignore
		}
	}
}
