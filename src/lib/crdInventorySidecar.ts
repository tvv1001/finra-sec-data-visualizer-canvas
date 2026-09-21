/**
 * Coverage-valid CRD inventory gzip sidecar (`data/crd-inventory.json.gz`).
 *
 * Cheap local census of unique firm|individual CRDs that have a real detail page.
 * Prefer this over Redis SCAN / per-key reads for totals. Names stay in search sidecars;
 * `data/crd-log.json` remains the capped MRU name list.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import zlib from 'zlib';

export type CrdInventoryCounts = {
	people: number;
	firms: number;
	unique: number;
};

export type CrdInventoryPayload = {
	version: 1;
	generatedAt: string;
	counts: CrdInventoryCounts;
	firms: number[];
	individuals: number[];
};

export type CrdInventoryEntity = {
	kind: 'firm' | 'individual';
	id: number | string;
};

const DEFAULT_RELATIVE_PATH = path.join('data', 'crd-inventory.json.gz');
const DEBOUNCE_MS = 1500;

let cache: CrdInventoryPayload | null = null;
let firmSet: Set<number> | null = null;
let individualSet: Set<number> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<boolean> | null = null;
let dirty = false;

export function getCrdInventoryPath(): string {
	return process.env.CRD_INVENTORY_PATH || path.join(process.cwd(), DEFAULT_RELATIVE_PATH);
}

export function resetCrdInventoryModuleCache() {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	flushPromise = null;
	dirty = false;
	cache = null;
	firmSet = null;
	individualSet = null;
}

function emptyPayload(generatedAt = new Date().toISOString()): CrdInventoryPayload {
	return {
		version: 1,
		generatedAt,
		counts: { people: 0, firms: 0, unique: 0 },
		firms: [],
		individuals: [],
	};
}

function normalizeIdList(values: unknown): number[] {
	if (!Array.isArray(values)) return [];
	const out: number[] = [];
	const seen = new Set<number>();
	for (const value of values) {
		const id = Number(value);
		if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function countsFromLists(firms: number[], individuals: number[]): CrdInventoryCounts {
	return {
		people: individuals.length,
		firms: firms.length,
		unique: firms.length + individuals.length,
	};
}

function payloadFromSets(firms: Set<number>, individuals: Set<number>, generatedAt = new Date().toISOString()): CrdInventoryPayload {
	const firmList = Array.from(firms).sort((a, b) => a - b);
	const individualList = Array.from(individuals).sort((a, b) => a - b);
	return {
		version: 1,
		generatedAt,
		counts: countsFromLists(firmList, individualList),
		firms: firmList,
		individuals: individualList,
	};
}

function ensureSetsFromCache() {
	if (firmSet && individualSet && cache) return;
	const payload = cache ?? emptyPayload();
	firmSet = new Set(payload.firms);
	individualSet = new Set(payload.individuals);
	cache = payload;
}

function parseInventoryBuffer(buf: Buffer): CrdInventoryPayload | null {
	try {
		const jsonText =
			buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ?
				zlib.gunzipSync(buf).toString('utf8')
			:	buf.toString('utf8');
		const parsed = JSON.parse(jsonText);
		const firms = normalizeIdList(parsed?.firms);
		const individuals = normalizeIdList(parsed?.individuals);
		return {
			version: 1,
			generatedAt: String(parsed?.generatedAt || new Date().toISOString()),
			counts: countsFromLists(firms, individuals),
			firms,
			individuals,
		};
	} catch {
		return null;
	}
}

export function loadCrdInventorySync(): CrdInventoryPayload {
	if (cache) return cache;
	try {
		const buf = fsSync.readFileSync(getCrdInventoryPath());
		const parsed = parseInventoryBuffer(buf);
		cache = parsed ?? emptyPayload();
	} catch {
		cache = emptyPayload();
	}
	firmSet = new Set(cache.firms);
	individualSet = new Set(cache.individuals);
	return cache;
}

export function getCrdInventoryCounts(): CrdInventoryCounts {
	const payload = loadCrdInventorySync();
	return { ...payload.counts };
}

export function isCrdInInventory(id: number | string): { isFirm: boolean; isIndividual: boolean } {
	loadCrdInventorySync();
	ensureSetsFromCache();
	const numId = Number(id);
	return {
		isFirm: firmSet?.has(numId) ?? false,
		isIndividual: individualSet?.has(numId) ?? false,
	};
}

export function hasCrdInventorySidecar(): boolean {
	try {
		return fsSync.existsSync(getCrdInventoryPath());
	} catch {
		return false;
	}
}

async function writePayloadToDisk(payload: CrdInventoryPayload): Promise<boolean> {
	if (process.env.VERCEL) return false;
	const target = getCrdInventoryPath();
	const dir = path.dirname(target);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.mkdir(dir, { recursive: true });
		const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
		await fs.writeFile(tmp, gz);
		await fs.rename(tmp, target);
		return true;
	} catch (e: any) {
		try {
			await fs.unlink(tmp);
		} catch {
			/* ignore */
		}
		console.warn('Failed to write CRD inventory sidecar:', e?.message || e);
		return false;
	}
}

/** Flush pending debounced writes immediately (also used by tests). */
export async function flushCrdInventorySidecar(): Promise<boolean> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (!dirty) return true;
	if (flushPromise) return flushPromise;

	flushPromise = (async () => {
		ensureSetsFromCache();
		const payload = payloadFromSets(firmSet!, individualSet!);
		cache = payload;
		dirty = false;
		const ok = await writePayloadToDisk(payload);
		flushPromise = null;
		return ok;
	})();

	return flushPromise;
}

function scheduleFlush() {
	dirty = true;
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushCrdInventorySidecar();
	}, DEBOUNCE_MS);
	if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
		try {
			(flushTimer as NodeJS.Timeout).unref();
		} catch {
			/* ignore */
		}
	}
}

/**
 * Merge coverage-valid entities into the sidecar (debounced disk write).
 * Callers must only pass entities that already passed host coverage.
 */
export async function rememberInventoryEntities(entries: CrdInventoryEntity[]): Promise<{ added: number; counts: CrdInventoryCounts }> {
	if (!entries.length) {
		const counts = getCrdInventoryCounts();
		return { added: 0, counts };
	}
	loadCrdInventorySync();
	ensureSetsFromCache();

	let added = 0;
	for (const entry of entries) {
		const id = Number(entry.id);
		if (!Number.isFinite(id) || id <= 0) continue;
		const set = entry.kind === 'firm' ? firmSet! : individualSet!;
		if (set.has(id)) continue;
		set.add(id);
		added += 1;
	}

	if (added > 0) {
		cache = payloadFromSets(firmSet!, individualSet!);
		scheduleFlush();
	}

	return { added, counts: { ...cache!.counts } };
}

/** Full replace used by reconcile / offline rebuilds. Writes immediately. */
export async function replaceCrdInventory(input: {
	firms: Iterable<number | string>;
	individuals: Iterable<number | string>;
}): Promise<CrdInventoryPayload> {
	const firms = new Set<number>();
	const individuals = new Set<number>();
	for (const value of input.firms) {
		const id = Number(value);
		if (Number.isFinite(id) && id > 0) firms.add(id);
	}
	for (const value of input.individuals) {
		const id = Number(value);
		if (Number.isFinite(id) && id > 0) individuals.add(id);
	}

	const payload = payloadFromSets(firms, individuals);
	cache = payload;
	firmSet = firms;
	individualSet = individuals;
	dirty = false;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	await writePayloadToDisk(payload);
	return payload;
}
