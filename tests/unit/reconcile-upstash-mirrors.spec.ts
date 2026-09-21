import { describe, expect, it } from 'vitest';
import {
	ArgError,
	NAMESPACE_ALLOWLIST,
	TTL_STATE,
	classifyTtlState,
	parseArgs,
	planKeyReconciliation,
	reconcileNamespace,
	reconcileNamespaceLocalWins,
	sha256Hex,
	shortDigest,
	validateLimit,
	validateNamespace,
	verifyUnion,
} from '../../.local/scripts/reconcile-upstash-mirrors.mjs';

/** Minimal in-memory store double implementing the same adapter surface as
 *  createLocalStore()/createUpstashStore() — no real Redis/Upstash network
 *  calls are ever made by these tests. */
function makeFakeStore(label, entries = {}) {
	const data = new Map(Object.entries(entries));
	const setNxCalls: any[] = [];
	const setOverwriteCalls: any[] = [];
	return {
		label,
		host: `${label}.test`,
		data,
		setNxCalls,
		setOverwriteCalls,
		async scanNamespace(prefix: string) {
			return [...data.keys()].filter((k) => k.startsWith(prefix));
		},
		async typeOf(key: string) {
			return data.has(key) ? data.get(key).type : 'none';
		},
		async getString(key: string) {
			const entry = data.get(key);
			return entry && entry.type === 'string' ? entry.value : null;
		},
		async pttl(key: string) {
			const entry = data.get(key);
			if (!entry || entry.type !== 'string') return -2;
			return entry.pttlMs ?? -1;
		},
		async setNx(key: string, value: string, ttlState: string, pttlMs: number) {
			setNxCalls.push({ key, value, ttlState, pttlMs });
			if (data.has(key)) return false;
			data.set(key, { type: 'string', value, pttlMs: ttlState === TTL_STATE.EXPIRING ? pttlMs : -1 });
			return true;
		},
		async setOverwrite(key: string, value: string, ttlState: string, pttlMs: number) {
			setOverwriteCalls.push({ key, value, ttlState, pttlMs });
			data.set(key, { type: 'string', value, pttlMs: ttlState === TTL_STATE.EXPIRING ? pttlMs : -1 });
			return true;
		},
	};
}

describe('parseArgs / validation', () => {
	it('parses a valid single-namespace audit invocation with defaults', () => {
		const opts = parseArgs(['--namespace=finra:individual:']);
		expect(opts).toEqual({ apply: false, overwriteLocal: false, namespaces: ['finra:individual:'], limit: 500 });
	});

	it('accepts repeated --namespace flags, dedupes, and honors --apply/--limit', () => {
		const opts = parseArgs([
			'--namespace=finra:individual:',
			'--namespace=firm-connections:firm:',
			'--namespace=finra:individual:',
			'--limit=25',
			'--apply',
		]);
		expect(opts.apply).toBe(true);
		expect(opts.limit).toBe(25);
		expect(opts.namespaces).toEqual(['finra:individual:', 'firm-connections:firm:']);
	});

	it('rejects when no --namespace is provided', () => {
		expect(() => parseArgs(['--limit=10'])).toThrow(ArgError);
	});

	it('rejects an unknown argument', () => {
		expect(() => parseArgs(['--namespace=finra:individual:', '--bogus'])).toThrow(ArgError);
	});

	it('rejects a namespace outside the allowlist', () => {
		expect(() => validateNamespace('unapproved:prefix:')).toThrow(ArgError);
	});

	it('rejects a namespace with glob characters even if prefix-like', () => {
		expect(() => validateNamespace('finra:individual:*')).toThrow(ArgError);
		expect(() => validateNamespace('finra:individual:?')).toThrow(ArgError);
		expect(() => validateNamespace('finra:individual:[a]')).toThrow(ArgError);
	});

	it('rejects an empty namespace', () => {
		expect(() => validateNamespace('')).toThrow(ArgError);
	});

	it('every allowlist entry itself validates cleanly', () => {
		for (const ns of NAMESPACE_ALLOWLIST) {
			expect(() => validateNamespace(ns)).not.toThrow();
		}
	});

	it('rejects non-positive or non-integer limits', () => {
		expect(() => validateLimit('0')).toThrow(ArgError);
		expect(() => validateLimit('-5')).toThrow(ArgError);
		expect(() => validateLimit('12.5')).toThrow(ArgError);
		expect(() => validateLimit('abc')).toThrow(ArgError);
	});

	it('accepts a positive integer limit', () => {
		expect(validateLimit('10')).toBe(10);
	});
});

describe('classifyTtlState', () => {
	it('maps -1 to persistent', () => {
		expect(classifyTtlState(-1)).toBe(TTL_STATE.PERSISTENT);
	});
	it('maps a positive number to expiring', () => {
		expect(classifyTtlState(60_000)).toBe(TTL_STATE.EXPIRING);
	});
	it('maps -2 (and other unexpected values) to vanished', () => {
		expect(classifyTtlState(-2)).toBe(TTL_STATE.VANISHED);
		expect(classifyTtlState(0)).toBe(TTL_STATE.VANISHED);
	});
});

describe('sha256Hex / shortDigest', () => {
	it('is deterministic and content-sensitive', () => {
		expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
		expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
	});
	it('shortDigest truncates to 12 hex chars', () => {
		expect(shortDigest('abc')).toHaveLength(12);
		expect(shortDigest('abc')).toBe(sha256Hex('abc').slice(0, 12));
	});
});

describe('planKeyReconciliation', () => {
	it('returns noop when nothing is present anywhere', () => {
		expect(planKeyReconciliation([{ store: 'a', exists: false }, { store: 'b', exists: false }]).action).toBe('noop');
	});

	it('plans a copy to all stores missing a single source of truth', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT, value: 'v', pttlMs: -1 },
			{ store: 'db1', exists: false },
			{ store: 'db2', exists: false },
		]);
		expect(plan.action).toBe('copy');
		expect(plan.source.store).toBe('local');
		expect(plan.targets.sort()).toEqual(['db1', 'db2']);
	});

	it('plans a copy only to the store(s) actually missing it when others agree', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
			{ store: 'db1', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
			{ store: 'db2', exists: false },
		]);
		expect(plan.action).toBe('copy');
		expect(plan.targets).toEqual(['db2']);
	});

	it('flags a conflict when present sources disagree on digest', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
			{ store: 'db1', exists: true, digest: 'd2', ttlState: TTL_STATE.PERSISTENT },
		]);
		expect(plan.action).toBe('conflict');
	});

	it('flags a conflict when present sources agree on digest but disagree on TTL state', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
			{ store: 'db1', exists: true, digest: 'd1', ttlState: TTL_STATE.EXPIRING },
		]);
		expect(plan.action).toBe('conflict');
	});

	it('reports unsupported-type and never proposes a copy for it', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, unsupported: true, type: 'hash' },
			{ store: 'db1', exists: false },
		]);
		expect(plan.action).toBe('unsupported-type');
	});

	it('surfaces a snapshot error without proposing a copy', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', error: 'boom' },
			{ store: 'db1', exists: false },
		]);
		expect(plan.action).toBe('error');
	});

	it('returns in-sync when all stores already agree and none are missing', () => {
		const plan = planKeyReconciliation([
			{ store: 'local', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
			{ store: 'db1', exists: true, digest: 'd1', ttlState: TTL_STATE.PERSISTENT },
		]);
		expect(plan.action).toBe('in-sync');
	});
});

describe('reconcileNamespace (audit mode — never mutates)', () => {
	it('reports would-copy without calling setNx on any store', async () => {
		const local = makeFakeStore('local', { 'finra:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		const db2 = makeFakeStore('db2', {});
		const stores = [local, db1, db2];

		const result = await reconcileNamespace({ stores, prefix: 'finra:individual:', limit: 500, apply: false });

		expect(result.wouldCopy).toHaveLength(2);
		expect(result.copied).toHaveLength(0);
		expect(local.setNxCalls).toHaveLength(0);
		expect(db1.setNxCalls).toHaveLength(0);
		expect(db2.setNxCalls).toHaveLength(0);
		// Audit mode must not have mutated the underlying fake data either.
		expect(db1.data.has('finra:individual:1')).toBe(false);
		expect(db2.data.has('finra:individual:1')).toBe(false);
	});

	it('never reads or mutates unsupported (non-string) types', async () => {
		const local = makeFakeStore('local', { 'finra:individual:1': { type: 'hash' } });
		const db1 = makeFakeStore('db1', {});
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'finra:individual:', limit: 500, apply: false });

		expect(result.unsupported).toHaveLength(1);
		expect(result.copied).toHaveLength(0);
		expect(result.wouldCopy).toHaveLength(0);
		expect(db1.setNxCalls).toHaveLength(0);
	});

	it('reports a conflict and proposes no copy when sources disagree', async () => {
		const local = makeFakeStore('local', { 'finra:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'finra:individual:1': { type: 'string', value: 'B', pttlMs: -1 } });
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'finra:individual:', limit: 500, apply: false });

		expect(result.conflicts).toHaveLength(1);
		expect(result.wouldCopy).toHaveLength(0);
	});

	it('bounds the union to --limit keys even if more exist', async () => {
		const entries: Record<string, any> = {};
		for (let i = 0; i < 10; i += 1) entries[`finra:individual:${i}`] = { type: 'string', value: `v${i}`, pttlMs: -1 };
		const local = makeFakeStore('local', entries);
		const db1 = makeFakeStore('db1', {});
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'finra:individual:', limit: 3, apply: false });

		expect(result.unionCount).toBe(3);
		expect(result.wouldCopy.length).toBeLessThanOrEqual(3);
	});
});

describe('reconcileNamespace (apply mode)', () => {
	it('copies a persistent key with SET NX and no TTL option', async () => {
		const local = makeFakeStore('local', { 'sec:firm:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'sec:firm:', limit: 500, apply: true });

		expect(result.copied).toHaveLength(1);
		expect(db1.setNxCalls).toEqual([{ key: 'sec:firm:1', value: 'A', ttlState: TTL_STATE.PERSISTENT, pttlMs: -1 }]);
		expect(db1.data.get('sec:firm:1')).toMatchObject({ value: 'A', pttlMs: -1 });
	});

	it('copies an expiring key preserving the PTTL as PX', async () => {
		const local = makeFakeStore('local', { 'sec:firm:2': { type: 'string', value: 'B', pttlMs: 42_000 } });
		const db1 = makeFakeStore('db1', {});
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'sec:firm:', limit: 500, apply: true });

		expect(result.copied).toHaveLength(1);
		expect(db1.setNxCalls[0]).toMatchObject({ key: 'sec:firm:2', value: 'B', ttlState: TTL_STATE.EXPIRING, pttlMs: 42_000 });
	});

	it('treats a concurrent-write race as a safe skip when the destination now matches the source', async () => {
		const local = makeFakeStore('local', { 'sec:firm:3': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		// Simulate another process winning the race right before our setNx call
		// by making setNx itself insert the same value out from under us.
		const originalSetNx = db1.setNx.bind(db1);
		db1.setNx = async (key: string, value: string, ttlState: string, pttlMs: number) => {
			db1.data.set(key, { type: 'string', value: 'A', pttlMs: -1 });
			return originalSetNx(key, value, ttlState, pttlMs);
		};
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'sec:firm:', limit: 500, apply: true });

		expect(result.concurrentSkips).toHaveLength(1);
		expect(result.copied).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it('escalates a concurrent-write race to a conflict when the destination now disagrees', async () => {
		const local = makeFakeStore('local', { 'sec:firm:4': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		const originalSetNx = db1.setNx.bind(db1);
		db1.setNx = async (key: string, value: string, ttlState: string, pttlMs: number) => {
			db1.data.set(key, { type: 'string', value: 'DIFFERENT', pttlMs: -1 });
			return originalSetNx(key, value, ttlState, pttlMs);
		};
		const stores = [local, db1];

		const result = await reconcileNamespace({ stores, prefix: 'sec:firm:', limit: 500, apply: true });

		expect(result.conflicts).toHaveLength(1);
		expect(result.concurrentSkips).toHaveLength(0);
		expect(result.copied).toHaveLength(0);
	});
});

describe('verifyUnion', () => {
	it('reports no drift when all stores agree', async () => {
		const local = makeFakeStore('local', { 'sec:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'sec:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const drift = await verifyUnion([local, db1], ['sec:individual:1']);
		expect(drift).toEqual([]);
	});

	it('reports an absence when one store still lacks the key', async () => {
		const local = makeFakeStore('local', { 'sec:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		const drift = await verifyUnion([local, db1], ['sec:individual:1']);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({ key: 'sec:individual:1', reason: 'absent' });
	});

	it('reports a conflict when stores disagree', async () => {
		const local = makeFakeStore('local', { 'sec:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'sec:individual:1': { type: 'string', value: 'B', pttlMs: -1 } });
		const drift = await verifyUnion([local, db1], ['sec:individual:1']);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({ key: 'sec:individual:1', reason: 'conflict' });
	});

	it('reports an unsupported-type entry as drift without crashing', async () => {
		const local = makeFakeStore('local', { 'sec:individual:1': { type: 'hash' } });
		const db1 = makeFakeStore('db1', { 'sec:individual:1': { type: 'string', value: 'A', pttlMs: -1 } });
		const drift = await verifyUnion([local, db1], ['sec:individual:1']);
		expect(drift).toHaveLength(1);
		expect(drift[0]).toMatchObject({ key: 'sec:individual:1', reason: 'unsupported-type' });
	});
});

describe('parseArgs — --overwrite-local flag', () => {
	it('defaults overwriteLocal to false', () => {
		const opts = parseArgs(['--namespace=finra:individual:']);
		expect(opts.overwriteLocal).toBe(false);
	});

	it('parses --overwrite-local independent of --apply (preview-only when apply is absent)', () => {
		const preview = parseArgs(['--namespace=finra:individual:', '--overwrite-local']);
		expect(preview).toEqual({ apply: false, overwriteLocal: true, namespaces: ['finra:individual:'], limit: 500 });

		const authorized = parseArgs(['--namespace=finra:individual:', '--apply', '--overwrite-local']);
		expect(authorized).toEqual({ apply: true, overwriteLocal: true, namespaces: ['finra:individual:'], limit: 500 });
	});
});

describe('reconcileNamespaceLocalWins (preview / dry-run — never mutates)', () => {
	it('proposes writes for cloud-absent and cloud-divergent keys without calling setOverwrite', async () => {
		const local = makeFakeStore('local', {
			'finra:individual:1': { type: 'string', value: 'A', pttlMs: -1 }, // absent on both clouds
			'finra:individual:2': { type: 'string', value: 'NEW', pttlMs: -1 }, // differs from clouds
		});
		const db1 = makeFakeStore('db1', { 'finra:individual:2': { type: 'string', value: 'OLD', pttlMs: -1 } });
		const db2 = makeFakeStore('db2', { 'finra:individual:2': { type: 'string', value: 'OLD', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1, db2], prefix: 'finra:individual:', limit: 500, apply: false });

		expect(result.wouldWrite).toHaveLength(4); // key1 -> db1,db2 ; key2 -> db1,db2
		expect(result.written).toHaveLength(0);
		expect(db1.setNxCalls).toHaveLength(0);
		expect(db1.data.has('finra:individual:1')).toBe(false);
		expect(db2.data.get('finra:individual:2')).toMatchObject({ value: 'OLD' });
	});

	it('minimizes writes: skips keys already identical (digest + TTL state) on a cloud store', async () => {
		const local = makeFakeStore('local', { 'sec:firm:1': { type: 'string', value: 'SAME', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'sec:firm:1': { type: 'string', value: 'SAME', pttlMs: -1 } }); // already in sync
		const db2 = makeFakeStore('db2', {}); // absent -> needs write

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1, db2], prefix: 'sec:firm:', limit: 500, apply: false });

		expect(result.alreadySyncedCount).toBe(1);
		expect(result.wouldWrite).toEqual([{ key: 'sec:firm:1', to: 'db2', ttlState: TTL_STATE.PERSISTENT, reason: 'absent' }]);
	});

	it('never touches keys that exist only in the cloud (absent locally)', async () => {
		const local = makeFakeStore('local', {});
		const db1 = makeFakeStore('db1', { 'sec:firm:99': { type: 'string', value: 'cloud-only', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1], prefix: 'sec:firm:', limit: 500, apply: false });

		expect(result.cloudOnlyKeys).toEqual(['sec:firm:99']);
		expect(result.wouldWrite).toHaveLength(0);
		expect(result.enforcedKeys).toHaveLength(0);
	});

	it('never reads or mutates non-string types on either side', async () => {
		const local = makeFakeStore('local', { 'finra:firm:1': { type: 'hash' } });
		const db1 = makeFakeStore('db1', {});
		const resultLocalHash = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1], prefix: 'finra:firm:', limit: 500, apply: false });
		expect(resultLocalHash.unsupported).toEqual([{ key: 'finra:firm:1', store: 'local', type: 'hash' }]);
		expect(resultLocalHash.wouldWrite).toHaveLength(0);

		const local2 = makeFakeStore('local', { 'finra:firm:2': { type: 'string', value: 'A', pttlMs: -1 } });
		const db1b = makeFakeStore('db1', { 'finra:firm:2': { type: 'set' } });
		const resultCloudSet = await reconcileNamespaceLocalWins({ localStore: local2, cloudStores: [db1b], prefix: 'finra:firm:', limit: 500, apply: false });
		expect(resultCloudSet.unsupported).toEqual([{ key: 'finra:firm:2', store: 'db1', type: 'set' }]);
		expect(resultCloudSet.wouldWrite).toHaveLength(0);
	});
});

describe('reconcileNamespaceLocalWins (apply mode — authorized overwrite)', () => {
	it('overwrites a divergent cloud value with local value, preserving persistent TTL state', async () => {
		const local = makeFakeStore('local', { 'sec:individual:1': { type: 'string', value: 'CORRECT', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'sec:individual:1': { type: 'string', value: 'STALE', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1], prefix: 'sec:individual:', limit: 500, apply: true });

		expect(result.written).toEqual([{ key: 'sec:individual:1', to: 'db1', reason: 'differs' }]);
		expect(db1.data.get('sec:individual:1')).toMatchObject({ value: 'CORRECT', pttlMs: -1 });
	});

	it('overwrites an absent cloud key and preserves the expiring PTTL as PX', async () => {
		const local = makeFakeStore('local', { 'sec:individual:2': { type: 'string', value: 'V', pttlMs: 55_000 } });
		const db1 = makeFakeStore('db1', {});

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1], prefix: 'sec:individual:', limit: 500, apply: true });

		expect(result.written).toEqual([{ key: 'sec:individual:2', to: 'db1', reason: 'absent' }]);
		expect(db1.data.get('sec:individual:2')).toMatchObject({ value: 'V', pttlMs: 55_000 });
	});

	it('performs zero writes when both clouds already match local exactly', async () => {
		const local = makeFakeStore('local', { 'firm-connections:firm:1': { type: 'string', value: 'X', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', { 'firm-connections:firm:1': { type: 'string', value: 'X', pttlMs: -1 } });
		const db2 = makeFakeStore('db2', { 'firm-connections:firm:1': { type: 'string', value: 'X', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1, db2], prefix: 'firm-connections:firm:', limit: 500, apply: true });

		expect(result.written).toHaveLength(0);
		expect(result.alreadySyncedCount).toBe(2);
		expect(db1.setNxCalls).toHaveLength(0);
	});

	it('leaves cloud-only keys untouched (no delete, no write) even in apply mode', async () => {
		const local = makeFakeStore('local', {});
		const db1 = makeFakeStore('db1', { 'firm-connections:firm:2': { type: 'string', value: 'cloud-only', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1], prefix: 'firm-connections:firm:', limit: 500, apply: true });

		expect(result.written).toHaveLength(0);
		expect(result.cloudOnlyKeys).toEqual(['firm-connections:firm:2']);
		expect(db1.data.get('firm-connections:firm:2')).toMatchObject({ value: 'cloud-only' });
	});

	it('post-apply, verifyUnion over enforcedKeys reports no drift', async () => {
		const local = makeFakeStore('local', { 'sec:firm:5': { type: 'string', value: 'Z', pttlMs: -1 } });
		const db1 = makeFakeStore('db1', {});
		const db2 = makeFakeStore('db2', { 'sec:firm:5': { type: 'string', value: 'OLD', pttlMs: -1 } });

		const result = await reconcileNamespaceLocalWins({ localStore: local, cloudStores: [db1, db2], prefix: 'sec:firm:', limit: 500, apply: true });
		expect(result.written).toHaveLength(2);

		const drift = await verifyUnion([local, db1, db2], result.enforcedKeys);
		expect(drift).toEqual([]);
	});
});
