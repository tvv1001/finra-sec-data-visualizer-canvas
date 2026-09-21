import type { Redis } from '@upstash/redis';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { getRedisClientInstance } from '@/lib/redisClient';
import { DEFAULT_TTL_SECONDS, setStringIfValid } from '@/lib/redisCache';

export const PRIMED_BUNDLE_NAMES = ['finra-individual', 'sec-individual', 'finra-firm', 'sec-firm'] as const;

export type PrimedBundleName = (typeof PRIMED_BUNDLE_NAMES)[number];

type PrimedBundle = Record<string, unknown>;

type PrimedBackfillEntry = {
	bundleName: PrimedBundleName;
	sourceKey: string;
	targetKey: string;
	payload: unknown;
};

export type PrimedBackfillOptions = {
	bundleNames?: PrimedBundleName[] | string[] | string;
	maxRecords?: number;
	cursor?: number;
	overwrite?: boolean;
	dryRun?: boolean;
	ttlSeconds?: number;
};

export type PrimedBackfillRecordResult = {
	bundleName: PrimedBundleName;
	sourceKey: string;
	targetKey: string;
	action: 'would-write' | 'written' | 'skipped-existing' | 'error';
	status?: string;
};

export type PrimedBackfillResult = {
	bundleNames: PrimedBundleName[];
	cursor: number;
	nextCursor: number | null;
	hasMore: boolean;
	totalRecords: number;
	maxRecords: number;
	overwrite: boolean;
	dryRun: boolean;
	ttlSeconds: number;
	scanned: number;
	written: number;
	skippedExisting: number;
	failed: number;
	records: PrimedBackfillRecordResult[];
};

export type PrimedBackfillDeps = {
	redis?: Pick<Redis, 'get'> | null;
	loadBundle?: (bundleName: PrimedBundleName) => Promise<PrimedBundle | null>;
	hasExistingKey?: (key: string) => Promise<boolean>;
	writeRecord?: (key: string, raw: string, ttlSeconds: number) => Promise<string>;
};

const PRIMED_CACHE_DIR = path.resolve(process.cwd(), 'data', 'national', 'primed-cache');

function isPrimedBundleName(value: string): value is PrimedBundleName {
	return (PRIMED_BUNDLE_NAMES as readonly string[]).includes(value);
}

export function normalizePrimedRedisRecordKey(key: string): string {
	const match = /^(finra|sec):(individual|firm):(\d{1,10}|8-\d+)(?::.+)?$/i.exec(String(key || '').trim());
	if (!match) return String(key || '').trim();
	return `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}`;
}

export function resolvePrimedBundleNames(input?: PrimedBackfillOptions['bundleNames']): PrimedBundleName[] {
	if (typeof input === 'string') {
		const split = input
			.split(/[\s,;]+/g)
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean);
		const names = Array.from(new Set(split.filter(isPrimedBundleName)));
		return names.length ? names : [...PRIMED_BUNDLE_NAMES];
	}

	if (Array.isArray(input)) {
		const names = Array.from(
			new Set(
				input
					.map((value) =>
						String(value || '')
							.trim()
							.toLowerCase(),
					)
					.filter(isPrimedBundleName),
			),
		) as PrimedBundleName[];
		return names.length ? names : [...PRIMED_BUNDLE_NAMES];
	}

	return [...PRIMED_BUNDLE_NAMES];
}

function clampCursor(cursor: number | undefined) {
	const numeric = Number(cursor || 0);
	if (!Number.isFinite(numeric) || numeric < 0) return 0;
	return Math.floor(numeric);
}

function clampMaxRecords(maxRecords: number | undefined) {
	const numeric = Number(maxRecords || 250);
	if (!Number.isFinite(numeric)) return 250;
	return Math.max(1, Math.min(5_000, Math.floor(numeric)));
}

export function normalizeBackfillTtlSeconds(ttlSeconds?: number | null) {
	if (ttlSeconds == null) return 0;
	const numeric = Number(ttlSeconds);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return Math.floor(numeric);
}

function normalizePrimedBundle(bundle: PrimedBundle): PrimedBundle {
	const normalized: PrimedBundle = {};
	for (const [key, value] of Object.entries(bundle || {})) {
		normalized[normalizePrimedRedisRecordKey(key)] = value;
	}
	return normalized;
}

export async function loadPrimedBundleFromDisk(bundleName: PrimedBundleName): Promise<PrimedBundle | null> {
	const binPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.bin`);
	const jsonPath = path.join(PRIMED_CACHE_DIR, `${bundleName}.json`);

	try {
		const rawBin = await readFile(binPath);
		const json = zlib.gunzipSync(rawBin).toString('utf8');
		return normalizePrimedBundle(JSON.parse(json) as PrimedBundle);
	} catch {
		// fall through to json fallback
	}

	try {
		const rawJson = await readFile(jsonPath, 'utf8');
		return normalizePrimedBundle(JSON.parse(rawJson) as PrimedBundle);
	} catch {
		return null;
	}
}

export function buildPrimedBackfillEntries(bundles: Partial<Record<PrimedBundleName, PrimedBundle | null>>, bundleNames: PrimedBundleName[]): PrimedBackfillEntry[] {
	const entries: PrimedBackfillEntry[] = [];

	for (const bundleName of bundleNames) {
		const bundle = bundles[bundleName];
		if (!bundle) continue;
		for (const sourceKey of Object.keys(bundle).sort((left, right) => left.localeCompare(right))) {
			entries.push({
				bundleName,
				sourceKey,
				targetKey: normalizePrimedRedisRecordKey(sourceKey),
				payload: bundle[sourceKey],
			});
		}
	}

	return entries;
}

export function createPrimedBackfillRedisClient(): Redis | null {
	// prefer MIRROR env var but fall back to legacy _2 names
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	return getRedisClientInstance({ url, token });
}

export async function backfillPrimedCacheToRedis(options: PrimedBackfillOptions = {}, deps: PrimedBackfillDeps = {}): Promise<PrimedBackfillResult> {
	const bundleNames = resolvePrimedBundleNames(options.bundleNames);
	const maxRecords = clampMaxRecords(options.maxRecords);
	const cursor = clampCursor(options.cursor);
	const overwrite = options.overwrite === true;
	const dryRun = options.dryRun === true;
	const ttlSeconds = normalizeBackfillTtlSeconds(options.ttlSeconds);
	const loadBundle = deps.loadBundle ?? loadPrimedBundleFromDisk;
	const redis = deps.redis ?? createPrimedBackfillRedisClient();
	const hasExistingKey =
		deps.hasExistingKey ??
		(async (key: string) => {
			if (!redis) return false;
			const value = await redis.get(key).catch(() => null);
			return value != null;
		});
	const writeRecord = deps.writeRecord ?? ((key: string, raw: string, ttl: number) => setStringIfValid(key, raw, ttl));

	const bundles: Partial<Record<PrimedBundleName, PrimedBundle | null>> = {};
	for (const bundleName of bundleNames) {
		bundles[bundleName] = await loadBundle(bundleName);
	}

	const allEntries = buildPrimedBackfillEntries(bundles, bundleNames);
	const batchEntries = allEntries.slice(cursor, cursor + maxRecords);
	const records: PrimedBackfillRecordResult[] = [];
	let written = 0;
	let skippedExisting = 0;
	let failed = 0;

	for (const entry of batchEntries) {
		if (!overwrite) {
			const exists = await hasExistingKey(entry.targetKey);
			if (exists) {
				skippedExisting += 1;
				records.push({
					bundleName: entry.bundleName,
					sourceKey: entry.sourceKey,
					targetKey: entry.targetKey,
					action: 'skipped-existing',
				});
				continue;
			}
		}

		if (dryRun) {
			records.push({
				bundleName: entry.bundleName,
				sourceKey: entry.sourceKey,
				targetKey: entry.targetKey,
				action: 'would-write',
			});
			continue;
		}

		const status = await writeRecord(entry.targetKey, JSON.stringify(entry.payload), ttlSeconds);
		if (status === 'written') {
			written += 1;
			records.push({
				bundleName: entry.bundleName,
				sourceKey: entry.sourceKey,
				targetKey: entry.targetKey,
				action: 'written',
				status,
			});
			continue;
		}

		failed += 1;
		records.push({
			bundleName: entry.bundleName,
			sourceKey: entry.sourceKey,
			targetKey: entry.targetKey,
			action: 'error',
			status,
		});
	}

	const nextCursor = cursor + batchEntries.length < allEntries.length ? cursor + batchEntries.length : null;

	return {
		bundleNames,
		cursor,
		nextCursor,
		hasMore: nextCursor != null,
		totalRecords: allEntries.length,
		maxRecords,
		overwrite,
		dryRun,
		ttlSeconds,
		scanned: batchEntries.length,
		written,
		skippedExisting,
		failed,
		records,
	};
}
