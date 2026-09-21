import type { Redis } from '@upstash/redis';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getRedisClientInstance } from '@/lib/redisClient';
import { gunzipOffload } from '@/lib/gzipWorker';

export type PeopleClusterManifest = {
	generatedAt?: string;
	sourceGraph?: string;
	thresholds?: Record<string, unknown>;
	clusterCount?: number;
	personCount?: number;
	firmCount?: number;
	clusters?: Array<{
		id?: string;
		clusterId?: string;
		representativePerson?: string;
		people?: string[];
		bridgeFirms?: string[];
		stats?: Record<string, unknown>;
		bundle?: { json?: string; bin?: string };
	}>;
	personToCluster?: Record<string, string>;
};

export type PeopleClusterBundle = {
	clusterId: string;
	representativePerson?: string;
	people: string[];
	bridgeFirms: string[];
	nodes: any[];
	links: any[];
	stats?: Record<string, unknown>;
};

const ROOT = process.cwd();
const PRIMED_CACHE_DIR = path.resolve(ROOT, 'data', 'national', 'primed-cache');
const MANIFEST_BUNDLE_NAME = 'people-cluster-map';
const CLUSTER_BUNDLE_PREFIX = 'people-cluster-';

let manifestCache: PeopleClusterManifest | null | undefined;
const bundleCache = new Map<string, PeopleClusterBundle | null>();
const redisClientCache = new Map<string, Redis | null>();

function normalizePersonId(personId: string) {
	const value = String(personId || '').trim();
	if (!value) return '';
	if (value.startsWith('person:')) return value;
	return `person:${value}`;
}

function isValidUpstashUrl(value: string) {
	return typeof value === 'string' && /^https:\/\/[^.].*\.upstash\.io\/?$/.test(value) && !value.includes('...');
}

function getRedis() {
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token || !isValidUpstashUrl(url)) return null;
	const cacheKey = `${url}::${token}`;
	if (redisClientCache.has(cacheKey)) return redisClientCache.get(cacheKey) ?? null;
	const client = getRedisClientInstance({ url, token });
	redisClientCache.set(cacheKey, client);
	return client;
}

function getBundlePaths(baseName: string) {
	return {
		jsonPath: path.join(PRIMED_CACHE_DIR, `${baseName}.json`),
		binPath: path.join(PRIMED_CACHE_DIR, `${baseName}.bin`),
	};
}

async function decodePayload(raw: string) {
	const json = await gunzipOffload(raw);
	return JSON.parse(json);
}

async function loadBundleFromRedis(baseName: string) {
	const redis = getRedis();
	if (!redis) return null;
	try {
		const raw = await redis.get<string>(`primed:bundle:${baseName}`);
		if (raw) return (await decodePayload(raw)) as PeopleClusterBundle | PeopleClusterManifest;

		const rawMeta = await redis.get<string>(`primed:bundle:${baseName}:meta`);
		if (!rawMeta) return null;
		const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
		const chunkCount = Number(meta?.chunks || meta?.parts || 0);
		if (!meta?.chunked || !Number.isFinite(chunkCount) || chunkCount <= 0) return null;

		const partPromises: Promise<string | null>[] = [];
		for (let index = 0; index < chunkCount; index += 1) {
			partPromises.push(redis.get<string>(`primed:bundle:${baseName}:part:${index}`));
		}
		const parts = await Promise.all(partPromises);
		if (parts.some((part) => part === null)) return null;
		return (await decodePayload(parts.filter((p): p is string => p !== null).join(''))) as PeopleClusterBundle | PeopleClusterManifest;
	} catch {
		return null;
	}
}

async function loadBundleFromDisk(baseName: string) {
	const { jsonPath, binPath } = getBundlePaths(baseName);
	try {
		const rawBin = await readFile(binPath);
		return (await decodePayload(rawBin.toString('base64'))) as PeopleClusterBundle | PeopleClusterManifest;
	} catch {
		// fall back to JSON
	}
	try {
		const raw = await readFile(jsonPath, 'utf-8');
		return JSON.parse(raw) as PeopleClusterBundle | PeopleClusterManifest;
	} catch {
		return null;
	}
}

async function loadBundle(baseName: string) {
	if (bundleCache.has(baseName)) return bundleCache.get(baseName) ?? null;
	const disk = await loadBundleFromDisk(baseName);
	if (disk) {
		bundleCache.set(baseName, disk as PeopleClusterBundle);
		return disk;
	}
	const redis = await loadBundleFromRedis(baseName);
	bundleCache.set(baseName, redis as PeopleClusterBundle | null);
	return redis;
}

export async function getPeopleClusterManifest(): Promise<PeopleClusterManifest | null> {
	if (manifestCache !== undefined) return manifestCache;
	const loaded = (await loadBundle(MANIFEST_BUNDLE_NAME)) as PeopleClusterManifest | null;
	manifestCache = loaded || null;
	return manifestCache;
}

export async function tryLoadPersonCluster(personId: string): Promise<PeopleClusterBundle | null> {
	const manifest = await getPeopleClusterManifest();
	if (!manifest?.personToCluster) return null;
	const personKey = normalizePersonId(personId);
	const clusterId = manifest.personToCluster[personKey];
	if (!clusterId || !clusterId.startsWith(CLUSTER_BUNDLE_PREFIX)) return null;
	const bundle = (await loadBundle(clusterId)) as PeopleClusterBundle | null;
	if (!bundle) return null;
	if (!bundle.clusterId) bundle.clusterId = clusterId;
	return bundle;
}
