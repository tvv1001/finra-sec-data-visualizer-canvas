import type { Redis } from '@upstash/redis';
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * graphStore.ts – Module-level graph file cache and helper utilities.
 * Shared by /api/finra/graph, /expand, /nodes-by-ids, /graph-search, /graph-append
 */
import { readFile, writeFile, access, mkdir, rename, unlink, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRedisClientInstance } from '@/lib/redisClient';
import { canWriteToRedis, isRedisCacheOnly } from '@/lib/redisAvailability';
import { setStringIfValid, decompressPayload } from '@/lib/redisCache';
import { gzipOffload, gunzipOffload } from './gzipWorker';
import { GRAPH_FILE, RECENT_SEEDS_FILE, SEED_BANK_FILE, SEED_PROFILES_FILE, SEEDS_FILE } from './graphDataPaths';

// Graph runtime state lives under `graph:`. `finra:` / `sec:` are source-record
// folders only (individual/firm payloads), treated equally.
const REDIS_GRAPH_KEY = 'graph:snapshot';
const REDIS_GRAPH_UPDATED_AT_KEY = 'graph:updated-at';
const REDIS_SEED_BANK_KEY = 'graph:seed-bank';
const REDIS_RECENT_SEEDS_KEY = 'graph:recent-seeds';
const EMPTY_GRAPH = { nodes: [], links: [], meta: {} };

type SeedBank = {
	individualIds: string[];
	firmIds: string[];
	entityIds: string[];
	otherIds: string[];
	allNodeIds: string[];
	nameByNumber: {
		individual: Record<string, string>;
		firm: Record<string, string>;
	};
	updatedAt: string;
	counts: {
		individuals: number;
		firms: number;
		entities: number;
		others: number;
		totalNodes: number;
	};
};

type RecentSeeds = {
	individualIds: string[];
	firmIds: string[];
	updatedAt: string;
};

export type SeedLookupKind = 'individual' | 'firm';

let _redis: Redis | null = null;
function getRedis(): Redis | null {
	// Cache-only: skip Redis entirely and serve mem/disk/sidecars.
	if (isRedisCacheOnly()) return null;
	if (_redis !== null) return _redis;
	// prefer MIRROR env var but fall back to legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) _redis = getRedisClientInstance({ url, token });
	return _redis;
}

export let _graphCache: any = null;
let _graphCacheAt = 0;
let _graphAdjacency: Map<string, Set<string>> | null = null;
const GRAPH_CACHE_TTL_MS = 1 * 60 * 1000; // 1 min (reduced from 5 min)
const GRAPH_CACHE_TTL_CACHE_ONLY_MS = 15 * 60 * 1000; // keep warm longer when Redis R/W are off

function graphCacheTtlMs() {
	return isRedisCacheOnly() ? GRAPH_CACHE_TTL_CACHE_ONLY_MS : GRAPH_CACHE_TTL_MS;
}
let _graphBootstrapPromise: Promise<boolean> | null = null;
const execFileAsync = promisify(execFile);

export function invalidateGraphCache() {
	_graphCache = null;
	_graphCacheAt = 0;
	_graphAdjacency = null;
}

/** Keep the process-local graph warm without waiting on Redis/disk I/O. */
export function setGraphCacheWarm(graph: any) {
	_graphCache = graph;
	_graphCacheAt = Date.now();
	_graphAdjacency = null;
}

if (process.env.NODE_ENV !== 'test') {
	import('chokidar')
		.then(({ default: chokidar }) => {
			chokidar
				.watch(GRAPH_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
				.on('change', () => {
					invalidateGraphCache();
				})
				.on('unlink', () => {
					invalidateGraphCache();
				});
		})
		.catch(() => {});
}

export function getGraphAdjacency(graph: any): Map<string, Set<string>> {
	if (_graphAdjacency && _graphCache === graph) {
		return _graphAdjacency;
	}

	const adjacency = new Map<string, Set<string>>();
	const links = Array.isArray(graph.links) ? graph.links : [];

	for (const link of links) {
		const sourceId = resolveId(link.source);
		const targetId = resolveId(link.target);
		if (!sourceId || !targetId) continue;

		if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
		if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());

		adjacency.get(sourceId)!.add(targetId);
		adjacency.get(targetId)!.add(sourceId);
	}

	if (_graphCache === graph) {
		_graphAdjacency = adjacency;
	}
	return adjacency;
}

export async function getNeighborsForNodes(nodeIds: string[], hops: number | 'all' = 1) {
	const graph = await getFullGraph();
	const adjacency = getGraphAdjacency(graph);

	const visitedIds = new Set<string>();
	const distanceById = new Map<string, number>();
	const queue: string[] = [];

	nodeIds.forEach((id) => {
		if (id && adjacency.has(id)) {
			visitedIds.add(id);
			distanceById.set(id, 0);
			queue.push(id);
		}
	});

	for (let index = 0; index < queue.length; index += 1) {
		const currentId = queue[index];
		const currentDistance = distanceById.get(currentId) ?? 0;
		if (hops !== 'all' && currentDistance >= hops) continue;

		for (const neighborId of adjacency.get(currentId) || []) {
			if (visitedIds.has(neighborId)) continue;
			visitedIds.add(neighborId);
			distanceById.set(neighborId, currentDistance + 1);
			queue.push(neighborId);
		}
	}

	const nodes: any[] = graph.nodes || [];
	const links: any[] = graph.links || [];

	const resultNodes = nodes.filter((node) => visitedIds.has(node.id));
	const resultLinks = links.filter((link) => {
		const sourceId = resolveId(link.source);
		const targetId = resolveId(link.target);
		return visitedIds.has(sourceId!) && visitedIds.has(targetId!);
	});

	return { nodes: resultNodes, links: resultLinks };
}

export async function getNeighborsForNode(nodeId: string, hops: number | 'all' = 1) {
	return getNeighborsForNodes([nodeId], hops);
}

function normalizeGraphPayload(data: any) {
	if (!data || typeof data !== 'object') return { ...EMPTY_GRAPH };
	const normalizedLinks =
		Array.isArray(data.links) ?
			data.links.map((link: any) => {
				if (!link || typeof link !== 'object') return link;
				const sourceId = String(link.source?.id ?? link.source ?? '');
				const targetId = String(link.target?.id ?? link.target ?? '');
				const inferredRelationship =
					sourceId.startsWith('person:') && targetId.startsWith('firm:') ? 'employed_by'
					: (sourceId.startsWith('firm:') || sourceId.startsWith('entity:')) && targetId.startsWith('firm:') ? 'controls'
					: '';
				const relationship =
					typeof link.relationship === 'string' && link.relationship ? link.relationship
					: typeof link.type === 'string' && link.type ? link.type
					: inferredRelationship;
				const normalizedLink = relationship ? { ...link, relationship } : { ...link };
				if (normalizedLink.relationship === 'previous_employed_by' && normalizedLink.isCurrent === undefined) normalizedLink.isCurrent = false;
				if ('type' in normalizedLink) delete (normalizedLink as any).type;
				return normalizedLink;
			})
		:	[];
	return {
		nodes: Array.isArray(data.nodes) ? data.nodes : [],
		links: normalizedLinks,
		meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
	};
}

// Ensure each node has a non-placeholder-visible label before writing to
// a shared cache (Redis). This guards against storing numeric-only or
// CRD-like labels that the UI treats as placeholders and hides.
function normalizeGraphLabelsInPlace(graph: any) {
	if (!graph || !Array.isArray(graph.nodes)) return graph;
	for (const node of graph.nodes) {
		try {
			const label = String(node?.label || node?.name || node?.displayName || '').trim();
			const isNumeric = /^\d+$/.test(label);
			const isCrdLike = /^(?:crd|sec)#?\s*\d+$/i.test(label) || /^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(label) || /^8-\d+$/i.test(label);
			if (!label || isNumeric || isCrdLike) {
				const idText = String(node?.id || '').trim();
				node.label = idText ? `Node ${idText}` : label || '';
			}
		} catch (e) {
			// ignore per-node errors
		}
	}
	return graph;
}

async function decodeRedisGraphRaw(raw: unknown): Promise<any | null> {
	if (raw == null) return null;
	if (typeof raw !== 'string') return raw;

	let text = raw.trim();
	if (!text) return null;

	// Brotli payloads from redisCache.compressPayload (`br:<base64>`), introduced with the binary cache update.
	if (text.startsWith('br:')) {
		try {
			text = decompressPayload(text).trim();
		} catch {
			return null;
		}
		if (!text) return null;
	}

	const firstChar = text.charAt(0);
	if (firstChar === '{' || firstChar === '[') {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	// Legacy gzip+base64 payloads written by saveGraph()/gzipOffload.
	try {
		const json = await gunzipOffload(text);
		return JSON.parse(json);
	} catch {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}
}

/**
 * TODO(Performance): The JSON.parse(raw) here can block the event loop for massive graphs.
 * To move this off the main thread, consider using a lightweight streaming parser 
 * like stream-json, yield to the event loop using a chunked parser, or offload this 
 * work to a Web Worker / Worker Thread.
 */
function parseGraphPayload(raw: unknown, sourceLabel: string) {
	if (typeof raw === 'string') {
		if (!raw.trim()) return { ...EMPTY_GRAPH };
		try {
			return normalizeGraphPayload(JSON.parse(raw));
		} catch (error) {
			console.warn(`Failed to parse ${sourceLabel}; falling back to empty graph.`, error);
			return { ...EMPTY_GRAPH };
		}
	}
	return normalizeGraphPayload(raw);
}

function createEmptySeedBank(): SeedBank {
	return {
		individualIds: [],
		firmIds: [],
		entityIds: [],
		otherIds: [],
		allNodeIds: [],
		nameByNumber: { individual: {}, firm: {} },
		updatedAt: new Date(0).toISOString(),
		counts: { individuals: 0, firms: 0, entities: 0, others: 0, totalNodes: 0 },
	};
}

function uniqueSortedIds(values: unknown[]): string[] {
	return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function firstMeaningfulText(...values: unknown[]): string {
	for (const value of values) {
		const text = String(value || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) return text;
	}
	return '';
}

function normalizeSeedName(value: unknown): string {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	if (
		/^\d+$/.test(text) ||
		/^\d+-\d+$/.test(text) ||
		/^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(text) ||
		/^8-\d+$/i.test(text) ||
		/^person\s+\d+$/i.test(text) ||
		/^firm\s+\d+$/i.test(text)
	) {
		return '';
	}
	return text;
}

function getSeedNodeDisplayName(node: any): string {
	const basic = node?.basicInformation || {};
	if (node?.group === 'individual') {
		const fullName = [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ');
		return normalizeSeedName(firstMeaningfulText(fullName, basic.name, node?.name, node?.personName, node?.displayName, node?.legalName, node?.label));
	}
	if (node?.group === 'firm') {
		return normalizeSeedName(
			firstMeaningfulText(
				basic.firmName,
				basic.name,
				node?.firmName,
				node?.organizationName,
				node?.organization_name,
				node?.companyName,
				node?.name,
				node?.displayName,
				node?.legalName,
				node?.label,
			),
		);
	}
	return '';
}

function getNumericSeedNumber(nodeId: string, group: 'individual' | 'firm'): string {
	const prefix = group === 'individual' ? 'person:' : 'firm:';
	if (!nodeId.startsWith(prefix)) return '';
	const rawNumber = nodeId.slice(prefix.length).trim();
	return /^\d+$/.test(rawNumber) ? rawNumber : '';
}

function normalizeSeedNameMap(raw: unknown): { individual: Record<string, string>; firm: Record<string, string> } {
	const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const normalizeEntries = (entries: unknown) => {
		const output: Record<string, string> = {};
		if (!entries || typeof entries !== 'object') return output;
		for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
			const normalizedKey = String(key || '').trim();
			const normalizedValue = normalizeSeedName(value);
			if (!/^\d+$/.test(normalizedKey) || !normalizedValue) continue;
			output[normalizedKey] = normalizedValue;
		}
		return output;
	};

	return {
		individual: normalizeEntries(input.individual),
		firm: normalizeEntries(input.firm),
	};
}

function uniqueRecentIds(values: unknown[]): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const value of values) {
		const normalized = String(value || '').trim();
		if (!/^[0-9]+$/.test(normalized) || seen.has(normalized)) continue;
		seen.add(normalized);
		ids.push(normalized);
	}
	return ids.sort((left, right) => Number(right) - Number(left));
}

function buildSeedBankFromGraph(graph: any): SeedBank {
	const normalizedGraph = normalizeGraphPayload(graph);
	const individuals: string[] = [];
	const firms: string[] = [];
	const entities: string[] = [];
	const others: string[] = [];
	const allNodeIds: string[] = [];
	const nameByNumber = { individual: {} as Record<string, string>, firm: {} as Record<string, string> };

	for (const node of normalizedGraph.nodes) {
		const nodeId = resolveId(node);
		if (!nodeId) continue;
		allNodeIds.push(nodeId);
		switch (node?.group) {
			case 'individual':
				individuals.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'individual');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.individual[rawNumber] = displayName;
				}
				break;
			case 'firm':
				firms.push(nodeId);
				{
					const rawNumber = getNumericSeedNumber(nodeId, 'firm');
					const displayName = getSeedNodeDisplayName(node);
					if (rawNumber && displayName) nameByNumber.firm[rawNumber] = displayName;
				}
				break;
			case 'entity':
				entities.push(nodeId);
				break;
			default:
				others.push(nodeId);
				break;
		}
	}

	const individualIds = uniqueSortedIds(individuals);
	const firmIds = uniqueSortedIds(firms);
	const entityIds = uniqueSortedIds(entities);
	const otherIds = uniqueSortedIds(others);
	const uniqueAllNodeIds = uniqueSortedIds(allNodeIds);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds: uniqueAllNodeIds,
		nameByNumber,
		updatedAt: new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: uniqueAllNodeIds.length,
		},
	};
}

function normalizeSeedBankPayload(raw: unknown): SeedBank {
	if (!raw || typeof raw !== 'object') return createEmptySeedBank();
	const candidate = raw as Partial<SeedBank>;
	const individualIds = uniqueSortedIds(Array.isArray(candidate.individualIds) ? candidate.individualIds : []);
	const firmIds = uniqueSortedIds(Array.isArray(candidate.firmIds) ? candidate.firmIds : []);
	const entityIds = uniqueSortedIds(Array.isArray(candidate.entityIds) ? candidate.entityIds : []);
	const otherIds = uniqueSortedIds(Array.isArray(candidate.otherIds) ? candidate.otherIds : []);
	const allNodeIds = uniqueSortedIds(
		Array.isArray(candidate.allNodeIds) && candidate.allNodeIds.length ? candidate.allNodeIds : [...individualIds, ...firmIds, ...entityIds, ...otherIds],
	);

	return {
		individualIds,
		firmIds,
		entityIds,
		otherIds,
		allNodeIds,
		nameByNumber: normalizeSeedNameMap(candidate.nameByNumber),
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
		counts: {
			individuals: individualIds.length,
			firms: firmIds.length,
			entities: entityIds.length,
			others: otherIds.length,
			totalNodes: allNodeIds.length,
		},
	};
}

function createEmptyRecentSeeds(): RecentSeeds {
	return { individualIds: [], firmIds: [], updatedAt: new Date(0).toISOString() };
}

function normalizeRecentSeedsPayload(raw: unknown): RecentSeeds {
	if (!raw || typeof raw !== 'object') return createEmptyRecentSeeds();
	const candidate = raw as Partial<RecentSeeds>;
	return {
		individualIds: uniqueRecentIds(Array.isArray(candidate.individualIds) ? candidate.individualIds : []),
		firmIds: uniqueRecentIds(Array.isArray(candidate.firmIds) ? candidate.firmIds : []),
		updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString(),
	};
}

async function localGraphFileExists() {
	try {
		await access(GRAPH_FILE, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function readGraphFromDisk() {
	if (!(await localGraphFileExists())) return null;
	const raw = await readFile(GRAPH_FILE, 'utf-8');
	return parseGraphPayload(raw, GRAPH_FILE);
}

function isSessionResetEmptyGraph(graph: any) {
	if (!graph || typeof graph !== 'object') return false;
	const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
	const linkCount = Array.isArray(graph.links) ? graph.links.length : 0;
	const sourceLabel = String(graph.meta?.sourceLabel || '').trim();
	return nodeCount === 0 && linkCount === 0 && sourceLabel === '(session reset)';
}

async function ensureGraphFileFromCache() {
	let shouldForceFullRebuild = false;
	if (await localGraphFileExists()) {
		try {
			const diskGraph = await readGraphFromDisk();
			if (diskGraph && !isSessionResetEmptyGraph(diskGraph)) return true;
			shouldForceFullRebuild = true;
		} catch {
			// Fall through to rebuild attempt.
		}
	}
	if (_graphBootstrapPromise) return _graphBootstrapPromise;

	_graphBootstrapPromise = (async () => {
		try {
			const scriptPath = path.join(process.cwd(), 'scripts', 'build_graph_from_cache.js');
			const scriptArgs = [scriptPath, '--employment-scope', 'current', '--no-redis'];
			if (shouldForceFullRebuild) scriptArgs.push('--full');
			await execFileAsync(process.execPath, scriptArgs, {
				cwd: process.cwd(),
				env: process.env,
				maxBuffer: 10 * 1024 * 1024,
			});
			return await localGraphFileExists();
		} catch (error) {
			console.warn('Failed to rebuild missing finra-graph.json from cache.', error);
			return false;
		}
	})().finally(() => {
		_graphBootstrapPromise = null;
	});

	return _graphBootstrapPromise;
}

async function readSeedBankFromDisk() {
	try {
		const raw = await readFile(SEED_BANK_FILE, 'utf-8');
		return normalizeSeedBankPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function readRecentSeedsFromDisk() {
	try {
		const raw = await readFile(RECENT_SEEDS_FILE, 'utf-8');
		return normalizeRecentSeedsPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function writeTextFileAtomic(filePath: string, contents: string) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await writeFile(tempPath, contents, 'utf-8');
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

async function writeJsonFileAtomic(filePath: string, data: unknown) {
	await writeTextFileAtomic(filePath, JSON.stringify(data, null, 2));
}

async function saveSeedBankToDisk(seedBank: SeedBank) {
	await writeJsonFileAtomic(SEED_BANK_FILE, seedBank);
}

async function saveRecentSeedsToDisk(recentSeeds: RecentSeeds) {
	await writeJsonFileAtomic(RECENT_SEEDS_FILE, recentSeeds);
}

export async function saveSeedBankToStore(seedBank: SeedBank): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_SEED_BANK_KEY, JSON.stringify(seedBank));
		return;
	}
	await saveSeedBankToDisk(seedBank);
}

export async function saveRecentSeedsToStore(recentSeeds: RecentSeeds): Promise<void> {
	const normalized = normalizeRecentSeedsPayload(recentSeeds);
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_RECENT_SEEDS_KEY, JSON.stringify(normalized));
		return;
	}
	await saveRecentSeedsToDisk(normalized);
}

async function syncSeedBankFromGraph(graph: any): Promise<SeedBank> {
	const seedBank = buildSeedBankFromGraph(graph);
	await saveSeedBankToStore(seedBank);
	return seedBank;
}

export async function getSeedBankFromStore(): Promise<SeedBank> {
	const redis = getRedis();
	if (redis) {
		const raw = await redis.get<string>(REDIS_SEED_BANK_KEY);
		if (raw) return normalizeSeedBankPayload(typeof raw === 'string' ? JSON.parse(decompressPayload(raw)) : raw);
		const graph = await getFullGraph();
		return syncSeedBankFromGraph(graph);
	}

	const diskSeedBank = await readSeedBankFromDisk();
	if (diskSeedBank) return diskSeedBank;

	const graph = await getFullGraph();
	return syncSeedBankFromGraph(graph);
}

export async function getSeedNameByNumber(kind: SeedLookupKind, id: string): Promise<string | null> {
	const normalizedId = String(id || '').trim();
	if (!/^\d+$/.test(normalizedId)) return null;
	const seedBank = await getSeedBankFromStore();
	const lookup = seedBank.nameByNumber?.[kind];
	const value = lookup && typeof lookup === 'object' ? lookup[normalizedId] : '';
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function getRecentSeedsFromStore(): Promise<RecentSeeds> {
	const redis = getRedis();
	if (redis) {
		const raw = await redis.get<string>(REDIS_RECENT_SEEDS_KEY);
		if (raw) return normalizeRecentSeedsPayload(typeof raw === 'string' ? JSON.parse(decompressPayload(raw)) : raw);
		return createEmptyRecentSeeds();
	}

	const diskRecentSeeds = await readRecentSeedsFromDisk();
	return diskRecentSeeds || createEmptyRecentSeeds();
}

export async function rememberRecentSeed(kind: 'individual' | 'firm', id: string, maxItems = 250): Promise<void> {
	const normalizedId = String(id || '').trim();
	if (!/^[0-9]+$/.test(normalizedId)) return;

	const recentSeeds = await getRecentSeedsFromStore();
	const nextRecentSeeds: RecentSeeds = {
		...recentSeeds,
		updatedAt: new Date().toISOString(),
		individualIds: kind === 'individual' ? uniqueRecentIds([normalizedId, ...recentSeeds.individualIds]).slice(0, maxItems) : recentSeeds.individualIds,
		firmIds: kind === 'firm' ? uniqueRecentIds([normalizedId, ...recentSeeds.firmIds]).slice(0, maxItems) : recentSeeds.firmIds,
	};

	await saveRecentSeedsToStore(nextRecentSeeds);
}

async function syncGraphToRedisInBackground(graph: any, redis: Redis | null = getRedis()) {
	if (!graph || !redis) return;
	try {
		normalizeGraphLabelsInPlace(graph);
	} catch (e) {
		// ignore normalization failures and still try the sync
	}
	try {
		await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(graph));
		await redis.set(REDIS_GRAPH_UPDATED_AT_KEY, Date.now());
	} catch (error) {
		console.warn('Failed to sync graph into Redis in background.', error);
	}
	try {
		await syncSeedBankFromGraph(graph);
	} catch (error) {
		console.warn('Failed to sync seed bank from graph in background.', error);
	}
}

async function bootstrapGraphFromDisk(redis: Redis) {
	const diskGraph = await readGraphFromDisk();
	if (!diskGraph) return null;
	// Normalize labels before writing to shared Redis so clients won't
	// receive placeholder-only labels.
	try {
		normalizeGraphLabelsInPlace(diskGraph);
	} catch (e) {}
	void syncGraphToRedisInBackground(diskGraph, redis);
	return diskGraph;
}

export async function getFullGraph() {
	const now = Date.now();
	const redis = getRedis();

	// Check for remote cache buster if we have a cached graph. This ensures
	// warm instances detect dashboard updates immediately even before TTL expires.
	if (_graphCache && redis) {
		try {
			const updatedAt = await redis.get<number>(REDIS_GRAPH_UPDATED_AT_KEY);
			if (updatedAt && Number(updatedAt) > _graphCacheAt) {
				_graphCache = null;
				_graphCacheAt = 0;
			}
		} catch (e) {
			// ignore redis error and use cached graph or fallback
		}
	}

	const cacheTtl = graphCacheTtlMs();
	if (_graphCache && now - _graphCacheAt < cacheTtl) return _graphCache;
	if (_graphCache && now - _graphCacheAt >= cacheTtl) _graphCache = null;

	if (redis) {
		try {
			let raw = await redis.get<string>(REDIS_GRAPH_KEY);

			// Chunked national graph parts can be multi-MB. Redis is shared with other apps —
			// only pull parts when mono key is missing AND FINRA_LOAD_CHUNKED_GRAPH=1.
			// Deploy/admin scripts should rehydrate a compact `graph:snapshot` offline instead of
			// serving multi-MB parts on every serverless cold start.
			if (!raw && process.env.FINRA_LOAD_CHUNKED_GRAPH === '1') {
				const manifestKey = `${REDIS_GRAPH_KEY}:manifest`;
				const rawManifest = await redis.get<string>(manifestKey);
				if (rawManifest) {
					const manifest = typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest;
					const manifestParts = manifest.parts || 0;
					const partKeys = [];
					for (let i = 0; i < manifestParts; i++) {
						partKeys.push(`${REDIS_GRAPH_KEY}:part:${i}`);
					}
					const parts = partKeys.length > 0 ? await redis.mget<string[]>(...partKeys) : [];
					if (parts.every((part) => part !== null)) {
						raw = parts.join('');
					}
				}
			}

			if (raw) {
				// Support plain JSON, brotli (`br:`), and legacy gzip+base64 graph payloads.
				const parsedRaw = await decodeRedisGraphRaw(raw);
				if (parsedRaw) {
					const redisGraph = parseGraphPayload(parsedRaw, 'Redis graph payload');
					const isRedisGraphEmpty = (redisGraph.nodes?.length || 0) === 0 && (redisGraph.links?.length || 0) === 0;
					const redisSourceLabel = String(redisGraph.meta?.sourceLabel || '').trim();
					let useDiskGraph = false;

					if (isRedisGraphEmpty && redisSourceLabel === '(session reset)') {
						const diskGraph = await readGraphFromDisk();
						if (diskGraph && (diskGraph.nodes?.length || 0) > 0) {
							try {
								normalizeGraphLabelsInPlace(diskGraph);
								await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(diskGraph));
								await syncSeedBankFromGraph(diskGraph);
							} catch (error) {
								console.warn('Failed to restore Redis graph from disk after reset.', error);
							}
							_graphCache = diskGraph;
							_graphCacheAt = now;
							useDiskGraph = true;
						}
					}

					if (!useDiskGraph) {
						_graphCache = redisGraph;
						_graphCacheAt = now;
						if (process.env.VERCEL !== '1' && !(await localGraphFileExists())) {
							try {
								await writeJsonFileAtomic(GRAPH_FILE, _graphCache);
								await syncSeedBankFromGraph(_graphCache);
							} catch (error) {
								console.warn('Failed to restore local finra-graph.json from Redis payload.', error);
							}
						}
					}

					return _graphCache;
				}
			}
			if (await ensureGraphFileFromCache()) {
				const diskGraph = await readGraphFromDisk();
				if (diskGraph) {
					try {
						normalizeGraphLabelsInPlace(diskGraph);
					} catch (e) {}
					_graphCache = diskGraph;
					_graphCacheAt = now;
					void syncGraphToRedisInBackground(diskGraph, redis);
					return _graphCache;
				}
			}
			const boot = await bootstrapGraphFromDisk(redis);
			_graphCache = boot ?? { ...EMPTY_GRAPH };
			_graphCacheAt = now;
			return _graphCache;
		} catch (e) {
			// fall back to disk
		}
	}

	if (!(await ensureGraphFileFromCache())) {
		_graphCache = { ...EMPTY_GRAPH };
		_graphCacheAt = now;
		return _graphCache;
	}
	_graphCache = (await readGraphFromDisk()) || { ...EMPTY_GRAPH };
	_graphCacheAt = now;
	return _graphCache;
}

export async function saveGraph(data: any) {
	try {
		normalizeGraphLabelsInPlace(data);
	} catch (e) {}

	// Yield once so an in-flight search/health request can run before we spend
	// a long sync stretch compacting tens of thousands of nodes/links.
	await new Promise<void>((resolve) => setImmediate(resolve));

	const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
	const rawLinks = Array.isArray(data.links) ? data.links : [];
	const compactNodes: any[] = [];
	for (let i = 0; i < rawNodes.length; i += 1) {
		if (i > 0 && i % 5000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		compactNodes.push(toCompactNode(rawNodes[i]));
	}
	const compactLinks: any[] = [];
	for (let i = 0; i < rawLinks.length; i += 1) {
		if (i > 0 && i % 8000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		const l = rawLinks[i];
		compactLinks.push({
			source: typeof l.source === 'object' ? (l.source.id ?? l.source) : l.source,
			target: typeof l.target === 'object' ? (l.target.id ?? l.target) : l.target,
			relationship: l.relationship,
			firmId: l.firmId || l.firm_id || null,
			startDate: l.startDate || l.start || null,
			endDate: l.endDate || l.end || null,
		});
	}
	const compact = {
		nodes: compactNodes,
		links: compactLinks,
		meta: data.meta || {},
	};

	// Always keep process memory warm so cache-only / write-disabled modes can keep serving.
	_graphCache = compact;
	_graphCacheAt = Date.now();
	_graphAdjacency = null;

	const redis = getRedis();
	const allowRedisWrite = Boolean(redis) && canWriteToRedis() && !isRedisCacheOnly();
	if (allowRedisWrite && redis) {
		// Before storing in Redis, strip simulation state, heavy nested details, and compress payload
		try {
			const json = JSON.stringify(compact);
			// Offload gzip to background worker to avoid blocking the event loop.
			// Store the gzip+base64 payload directly (not through setStringIfValid/compressPayload)
			// so readers only need one decode step. setStringIfValid would wrap this in brotli (`br:`),
			// producing a double-compressed blob that older gunzip-only readers cannot open.
			const b64 = await gzipOffload(json);
			await redis.set(REDIS_GRAPH_KEY, b64);
			await redis.set(REDIS_GRAPH_UPDATED_AT_KEY, Date.now());
		} catch (e) {
			// On any failure, fall back to storing plain JSON (may still be brotli-wrapped by setStringIfValid;
			// decodeRedisGraphRaw handles both shapes).
			await setStringIfValid(REDIS_GRAPH_KEY, JSON.stringify(compact));
			try {
				await redis.set(REDIS_GRAPH_UPDATED_AT_KEY, Date.now());
			} catch {}
		}
	} else {
		// Disk is the durable fallback when Redis R/W are off (local/dev and cache-only drills).
		try {
			await writeJsonFileAtomic(GRAPH_FILE, compact);
		} catch (error) {
			console.warn('saveGraph: disk write failed while Redis writes are disabled', error);
		}
	}
	await syncSeedBankFromGraph(compact);
}

export async function clearGraphStore({ clearRecentSeeds = true }: { clearRecentSeeds?: boolean } = {}) {
	const emptyGraph = {
		...EMPTY_GRAPH,
		meta: {
			generated: new Date().toISOString(),
			sourceLabel: '(session reset)',
			totalIndividuals: 0,
			totalFirms: 0,
			totalEntities: 0,
			totalNodes: 0,
			totalLinks: 0,
		},
	};

	const redis = getRedis();
	if (redis) {
		await saveGraph(emptyGraph);
	} else {
		invalidateGraphCache();
	}

	if (clearRecentSeeds) {
		await saveRecentSeedsToStore(createEmptyRecentSeeds());
	}
}

export async function graphFileExists() {
	const redis = getRedis();
	if (redis) {
		const exists = await redis.exists(REDIS_GRAPH_KEY);
		if (exists > 0) return true;
		return localGraphFileExists();
	}
	return localGraphFileExists();
}

const D3_SIM_KEYS = ['x', 'y', 'vx', 'vy', 'fx', 'fy', 'index', '_detailLoaded'];

/** Graph wire/layout fields only — employment histories belong on detail/expand APIs. */
const GRAPH_NODE_KEEP_KEYS = new Set([
	'id',
	'label',
	'group',
	'crd',
	'bcScope',
	'iaScope',
	'firmStatus',
	'hasFinraData',
	'hasSecData',
	'disclosureFlag',
	'iaDisclosureFlag',
	'otherNames',
	'registrationCount',
	'firmCount',
	'knownConnectionCount',
	'firmName',
	'activeStates',
	'primaryOffice',
	'isLegacy',
	'stub',
	'orphan',
	'orphanParentCrd',
	'orphanFirmName',
	'orphanPosition',
	'orphanParentType',
	'parentCrd',
	'parentType',
	'parentName',
]);

const BASIC_INFO_KEEP_KEYS = new Set([
	'firmName',
	'firmId',
	'individualId',
	'firstName',
	'middleName',
	'lastName',
	'bcScope',
	'iaScope',
	'firmStatus',
	'otherNames',
]);

export function stripSimState(obj: Record<string, any>) {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(obj)) if (!D3_SIM_KEYS.includes(k)) out[k] = v;
	return out;
}

export function toCompactNode(node: any): any {
	if (!node || typeof node !== 'object') return node;
	const out: Record<string, any> = {};
	for (const key of GRAPH_NODE_KEEP_KEYS) {
		if (node[key] === undefined) continue;
		out[key] = node[key];
	}
	// Keep a tiny identity/status slice of basicInformation when present.
	const basic = node.basicInformation;
	if (basic && typeof basic === 'object' && !Array.isArray(basic)) {
		const slimBasic: Record<string, any> = {};
		for (const key of BASIC_INFO_KEEP_KEYS) {
			if (basic[key] !== undefined) slimBasic[key] = basic[key];
		}
		if (Object.keys(slimBasic).length) out.basicInformation = slimBasic;
	}
	return out;
}

export function resolveId(ref: any): string | null {
	if (ref && typeof ref === 'object') return ref.id ?? null;
	return ref ?? null;
}

let _seedsCache: string[] | null = null;
let _profilesCache: any = null;

export function getSeedsCache() {
	return _seedsCache;
}
export function setSeedsCache(v: string[]) {
	_seedsCache = v;
}
export function invalidateSeedsCache() {
	_seedsCache = null;
}

export function getProfilesCache() {
	return _profilesCache;
}
export function setProfilesCache(v: any) {
	_profilesCache = v;
}
export function invalidateProfilesCache() {
	_profilesCache = null;
}

const REDIS_PROFILES_KEY = 'graph:seed-profiles';
const REDIS_SEEDS_KEY = 'graph:seeds';

export async function getProfilesFromStore(): Promise<any> {
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_PROFILES_KEY);
			if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
			const data = JSON.parse(await readFile(SEED_PROFILES_FILE, 'utf-8'));
			await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(data));
			return data;
		} catch {
			return { profiles: [] };
		}
	}
	try {
		return JSON.parse(await readFile(SEED_PROFILES_FILE, 'utf-8'));
	} catch {
		return { profiles: [] };
	}
}

export async function saveProfilesToStore(data: any): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(data));
	} else {
		await writeJsonFileAtomic(SEED_PROFILES_FILE, data);
	}
	invalidateProfilesCache();
}

export async function getSeedsFromStore(): Promise<string[]> {
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_SEEDS_KEY);
			if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
			const data = JSON.parse(await readFile(SEEDS_FILE, 'utf-8'));
			await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(data));
			return data;
		} catch {
			return [];
		}
	}
	try {
		return JSON.parse(await readFile(SEEDS_FILE, 'utf-8'));
	} catch {
		return [];
	}
}

export async function saveSeedsToStore(seeds: string[]): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(seeds));
	} else {
		await writeJsonFileAtomic(SEEDS_FILE, seeds);
	}
	invalidateSeedsCache();
}
