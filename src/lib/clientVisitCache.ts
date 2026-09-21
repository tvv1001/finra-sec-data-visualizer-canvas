/**
 * Recently-visited record cache shared by the dashboard and the node graph.
 * Memory covers same-document navigations; IndexedDB survives dashboard ↔ graph reloads.
 */

const MEMORY_MAX = 40;
/** Firm connection rosters are large; keep a separate small hot set so they aren't evicted by detail clicks. */
const CONNECTIONS_MEMORY_MAX = 12;
const IDB_NAME = 'finra-visit-cache';
const IDB_STORE = 'records';
const IDB_VERSION = 1;

const memory = new Map<string, unknown>();
const connectionsMemory = new Map<string, unknown>();

function touchMemory(key: string, value: unknown) {
	memory.delete(key);
	memory.set(key, value);
	while (memory.size > MEMORY_MAX) {
		const oldest = memory.keys().next().value;
		if (oldest == null) break;
		memory.delete(oldest);
	}
}

function touchConnectionsMemory(key: string, value: unknown) {
	connectionsMemory.delete(key);
	connectionsMemory.set(key, value);
	while (connectionsMemory.size > CONNECTIONS_MEMORY_MAX) {
		const oldest = connectionsMemory.keys().next().value;
		if (oldest == null) break;
		connectionsMemory.delete(oldest);
	}
}

function isConnectionsKey(key: string) {
	return key.startsWith('connections:firm:');
}

export function visitDetailKey(entity: 'firm' | 'individual', id: string) {
	return `detail:${entity}:${String(id || '').trim()}`;
}

export function visitSnapshotKey(entity: 'firm' | 'individual', id: string) {
	return `snapshot:${entity}:${String(id || '').trim()}`;
}

export function visitConnectionsKey(firmId: string) {
	return `connections:firm:${String(firmId || '').trim()}`;
}

export function readVisitedSync<T = unknown>(key: string): T | null {
	if (!key) return null;
	if (isConnectionsKey(key)) {
		const value = connectionsMemory.get(key);
		return value == null ? null : (value as T);
	}
	const value = memory.get(key);
	return value == null ? null : (value as T);
}

function openVisitDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(IDB_STORE)) {
					db.createObjectStore(IDB_STORE);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export async function readVisited<T = unknown>(key: string): Promise<T | null> {
	const mem = readVisitedSync<T>(key);
	if (mem != null) return mem;
	if (!key) return null;
	const db = await openVisitDb();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, 'readonly');
			const req = tx.objectStore(IDB_STORE).get(key);
			req.onsuccess = () => {
				const value = req.result;
				if (value != null) {
					if (isConnectionsKey(key)) touchConnectionsMemory(key, value);
					else touchMemory(key, value);
				}
				resolve(value == null ? null : (value as T));
			};
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export function rememberVisited(key: string, value: unknown) {
	if (!key || value == null) return;
	if (isConnectionsKey(key)) touchConnectionsMemory(key, value);
	else touchMemory(key, value);
	void (async () => {
		const db = await openVisitDb();
		if (!db) return;
		try {
			const tx = db.transaction(IDB_STORE, 'readwrite');
			tx.objectStore(IDB_STORE).put(value, key);
		} catch {
			// ignore quota / clone errors on oversized payloads (mega-firm previous lists)
		}
	})();
}

export type CachedFirmConnectionsPayload = {
	found: true;
	firmId: string;
	currentConnections: any[];
	previousConnections: any[];
	cachedAt: number;
};

/** Persist a firm roster for instant dashboard revisits (memory + IndexedDB). */
export function rememberFirmConnectionsCache(
	firmId: string,
	payload: { currentConnections?: any[]; previousConnections?: any[] },
) {
	const id = String(firmId || '').trim();
	if (!id) return;
	rememberVisited(visitConnectionsKey(id), {
		found: true,
		firmId: id,
		currentConnections: Array.isArray(payload.currentConnections) ? payload.currentConnections : [],
		previousConnections: Array.isArray(payload.previousConnections) ? payload.previousConnections : [],
		cachedAt: Date.now(),
	} satisfies CachedFirmConnectionsPayload);
}
