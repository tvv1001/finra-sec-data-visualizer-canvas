import type { Redis } from '@upstash/redis';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getRedisClientInstance } from '@/lib/redisClient';
import { setStringIfValid } from '@/lib/redisCache';
import { RECENT_SEEDS_FILE, SEED_PROFILES_FILE, SEEDS_FILE } from './graphDataPaths';

export type RecentSeeds = {
	individualIds: string[];
	firmIds: string[];
	updatedAt: string;
};

const REDIS_PROFILES_KEY = 'graph:seed-profiles';
const REDIS_SEEDS_KEY = 'graph:seeds';
const REDIS_RECENT_SEEDS_KEY = 'graph:recent-seeds';

let redisClient: Redis | null = null;
let profilesCache: any = null;
let seedsCache: string[] | null = null;

function getRedis(): Redis | null {
	if (redisClient !== null) return redisClient;
	// prefer MIRROR env var but fall back to legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (url && token) redisClient = getRedisClientInstance({ url, token });
	return redisClient;
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

export function invalidateProfilesCache() {
	profilesCache = null;
}

export function invalidateSeedsCache() {
	seedsCache = null;
}

export async function getProfilesFromStore(): Promise<any> {
	if (profilesCache) return profilesCache;
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_PROFILES_KEY);
			if (raw) {
				profilesCache = typeof raw === 'string' ? JSON.parse(raw) : raw;
				return profilesCache;
			}
		} catch {
			// fall back to disk
		}
	}
	try {
		profilesCache = JSON.parse(await readFile(SEED_PROFILES_FILE, 'utf-8'));
		if (redis) await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(profilesCache), 0);
		return profilesCache;
	} catch {
		profilesCache = { profiles: [] };
		return profilesCache;
	}
}

export async function saveProfilesToStore(data: any): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_PROFILES_KEY, JSON.stringify(data), 0);
	} else {
		await writeJsonFileAtomic(SEED_PROFILES_FILE, data);
	}
	profilesCache = data;
}

export async function getSeedsFromStore(): Promise<string[]> {
	if (seedsCache) return seedsCache;
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_SEEDS_KEY);
			if (raw) {
				seedsCache = typeof raw === 'string' ? JSON.parse(raw) : raw;
				return seedsCache;
			}
		} catch {
			// fall back to disk
		}
	}
	try {
		seedsCache = JSON.parse(await readFile(SEEDS_FILE, 'utf-8'));
		if (redis) await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(seedsCache), 0);
		return seedsCache;
	} catch {
		seedsCache = [];
		return seedsCache;
	}
}

export async function saveSeedsToStore(seeds: string[]): Promise<void> {
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_SEEDS_KEY, JSON.stringify(seeds), 0);
	} else {
		await writeJsonFileAtomic(SEEDS_FILE, seeds);
	}
	seedsCache = seeds;
}

export async function getRecentSeedsFromStore(): Promise<RecentSeeds> {
	const redis = getRedis();
	if (redis) {
		try {
			const raw = await redis.get<string>(REDIS_RECENT_SEEDS_KEY);
			if (raw) return normalizeRecentSeedsPayload(typeof raw === 'string' ? JSON.parse(raw) : raw);
		} catch {
			// fall back to disk
		}
	}
	try {
		return normalizeRecentSeedsPayload(JSON.parse(await readFile(RECENT_SEEDS_FILE, 'utf-8')));
	} catch {
		return createEmptyRecentSeeds();
	}
}

export async function saveRecentSeedsToStore(recentSeeds: RecentSeeds): Promise<void> {
	const normalized = normalizeRecentSeedsPayload(recentSeeds);
	const redis = getRedis();
	if (redis) {
		await setStringIfValid(REDIS_RECENT_SEEDS_KEY, JSON.stringify(normalized), 0);
	} else {
		await writeJsonFileAtomic(RECENT_SEEDS_FILE, normalized);
	}
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
