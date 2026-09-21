/**
 * Shared CRD inventory log (`data/crd-log.json`).
 * Updated when dashboard saves records and when individual detail pages load
 * (so employer firm CRDs discovered from person employment stay inventoried).
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export type CrdLogEntry = { id: number; name: string };
export type CrdLog = { firms: CrdLogEntry[]; individuals: CrdLogEntry[] };

const CRD_LOG_PATH = path.join(process.cwd(), 'data', 'crd-log.json');
const CRD_LOG_MAX_ENTRIES = 5000;

let crdLogCache: CrdLog | null = null;

export function resetCrdLogModuleCache() {
	crdLogCache = null;
}

function normalizeEntries(arr: unknown[]): CrdLogEntry[] {
	return (Array.isArray(arr) ? arr : [])
		.map((entry) =>
			typeof entry === 'object' && entry !== null ?
				{ id: Number((entry as any).id), name: String((entry as any).name || '') }
			:	{ id: Number(entry), name: '' },
		)
		.filter((e) => Number.isFinite(e.id) && e.id > 0);
}

export function loadCrdLogSync(): CrdLog {
	if (crdLogCache) return crdLogCache;
	try {
		const raw = fsSync.readFileSync(CRD_LOG_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		crdLogCache = {
			firms: normalizeEntries(parsed.firms),
			individuals: normalizeEntries(parsed.individuals),
		};
	} catch {
		crdLogCache = { firms: [], individuals: [] };
	}
	return crdLogCache;
}

async function writeCrdLog(log: CrdLog) {
	if (process.env.VERCEL) return false;
	try {
		await fs.mkdir(path.dirname(CRD_LOG_PATH), { recursive: true });
		await fs.writeFile(CRD_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
		crdLogCache = log;
		return true;
	} catch (e: any) {
		console.warn('Failed to write CRD log:', e?.message || e);
		return false;
	}
}

function upsertEntry(arr: CrdLogEntry[], id: number, name?: string): CrdLogEntry[] {
	const filtered = arr.filter((e) => Number(e.id) !== Number(id));
	filtered.unshift({ id: Number(id), name: String(name || '') });
	return filtered.slice(0, CRD_LOG_MAX_ENTRIES);
}

/** Best-effort inventory upsert for one or more CRDs. */
export async function rememberCrdLogEntries(
	entries: Array<{ kind: 'firm' | 'individual'; id: string | number; name?: string }>,
): Promise<void> {
	if (!entries.length) return;
	try {
		const log = loadCrdLogSync();
		let firms = log.firms.slice();
		let individuals = log.individuals.slice();
		for (const entry of entries) {
			const id = Number(entry.id);
			if (!Number.isFinite(id) || id <= 0) continue;
			if (entry.kind === 'firm') firms = upsertEntry(firms, id, entry.name);
			else individuals = upsertEntry(individuals, id, entry.name);
		}
		await writeCrdLog({ firms, individuals });
	} catch (e: any) {
		console.warn('rememberCrdLogEntries error', e?.message || e);
	}
}
