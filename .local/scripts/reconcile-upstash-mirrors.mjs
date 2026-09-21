#!/usr/bin/env node
/**
 * Three-way audit/reconcile for the shared FINRA/SEC Redis mirrors.
 *
 * Compares local Redis (redis://127.0.0.1:6379), Upstash DB1
 * (UPSTASH_REDIS_REST_URL/_TOKEN) and Upstash DB2/MIRROR
 * (UPSTASH_REDIS_REST_URL_MIRROR/_TOKEN_MIRROR, falling back to the legacy
 * `_2` env names) independently — never through the app's dual-DB proxy.
 *
 * Two mutually-exclusive reconciliation strategies, selected by
 * `--overwrite-local`:
 *
 *   1. DEFAULT (safe, symmetric, no --overwrite-local): copies STRING keys
 *      that are missing on a subset of the three stores using `SET ... NX`
 *      (never overwrites an existing value). If two+ stores already hold a
 *      key but disagree, it is reported as a CONFLICT and never touched —
 *      no automatic winner is chosen.
 *
 *   2. LOCAL-WINS (`--overwrite-local`, explicitly authorized by the user):
 *      local Redis is treated as the source of truth. For each key that
 *      exists locally as a string, each cloud DB (DB1/DB2) is checked
 *      independently and OVERWRITTEN only when it is absent or its raw
 *      value/TTL-state differs from local's — minimizing writes by
 *      skipping any cloud key that's already identical to local. Keys that
 *      exist only in the cloud (absent locally) are left untouched and
 *      reported for visibility, never deleted. Non-string types are never
 *      read or mutated on either side, exactly as in the default mode.
 *
 * SAFETY MODEL (applies to both strategies)
 *   - Default mode is a read-only AUDIT (dry-run) regardless of strategy.
 *     No writes ever happen unless `--apply` is passed explicitly. Passing
 *     `--overwrite-local` alone (without `--apply`) previews the
 *     local-wins write plan without writing anything.
 *   - Only whole STRING keys under an approved --namespace=<prefix> are
 *     ever touched. Any other Redis type (hash/list/set/zset) is reported
 *     as "unsupported" and is never read, copied, or mutated.
 *   - Both audit and apply runs finish with a verification pass. Any
 *     remaining absence/conflict/type/error causes a non-zero exit code,
 *     so `--apply` is a deliberate, separate, explicit step from auditing.
 *     (Local-wins verification excludes cloud-only keys that were
 *     intentionally left untouched — those are informational, not drift.)
 *
 * USAGE
 *   Audit, default safe strategy (read-only, safe to run any time):
 *     node --env-file=.env.local .local/scripts/reconcile-upstash-mirrors.mjs \
 *       --namespace=finra:individual: --namespace=firm-connections:firm: --limit=500
 *
 *   Apply, default safe strategy (SET ... NX only for keys missing on a
 *   subset of stores; conflicts are still never auto-resolved):
 *     node --env-file=.env.local .local/scripts/reconcile-upstash-mirrors.mjs \
 *       --namespace=finra:individual: --namespace=firm-connections:firm: --limit=500 --apply
 *
 *   Preview local-wins overwrite plan (read-only; shows what --apply would
 *   overwrite on DB1/DB2, without writing anything):
 *     node --env-file=.env.local .local/scripts/reconcile-upstash-mirrors.mjs \
 *       --namespace=finra:individual: --namespace=firm-connections:firm: --limit=500 --overwrite-local
 *
 *   Apply local-wins overwrite (authorized destructive mode — local Redis
 *   overwrites divergent/missing keys on DB1 and DB2; keys already
 *   identical to local are skipped to minimize writes):
 *     node --env-file=.env.local .local/scripts/reconcile-upstash-mirrors.mjs \
 *       --namespace=finra:individual: --namespace=firm-connections:firm: --limit=500 --apply --overwrite-local
 *
 * ARGUMENTS
 *   --namespace=<prefix>  Repeatable. REQUIRED. Must exactly match one of
 *                          NAMESPACE_ALLOWLIST below (no globs, no partial
 *                          matches, no empty values).
 *   --limit=<N>            Optional. Positive integer, default 500. Bounds
 *                          how many keys are scanned/processed per
 *                          namespace so a single run has predictable
 *                          memory/read cost. Re-run (optionally with a
 *                          higher --limit) to converge a very large
 *                          namespace.
 *   --apply                Optional. Enables writes. Omit for audit/dry-run.
 *   --overwrite-local      Optional. Switches to the local-wins strategy
 *                          (see above). Combine with --apply to actually
 *                          write; without --apply it only previews the plan.
 *
 * ENV
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN                 (DB1)
 *   UPSTASH_REDIS_REST_URL_MIRROR / UPSTASH_REDIS_REST_TOKEN_MIRROR   (DB2)
 *   UPSTASH_REDIS_REST_URL_2 / UPSTASH_REDIS_REST_TOKEN_2             (DB2 legacy fallback)
 *   Local Redis is always redis://127.0.0.1:6379 — never configurable via
 *   env, so this script can never be pointed at a remote host by mistake.
 */
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import IORedis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';

/** Exact-literal allowlist. No globs, no prefixes-of-prefixes, no free text. */
export const NAMESPACE_ALLOWLIST = Object.freeze([
	'finra:individual:',
	'finra:firm:',
	'sec:individual:',
	'sec:firm:',
	'firm-connections:firm:',
]);

export const DEFAULT_LIMIT = 500;
export const LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';

const GLOB_CHARS = /[*?[\]]/;
const SCAN_COUNT = 500;

export const TTL_STATE = Object.freeze({
	PERSISTENT: 'persistent',
	EXPIRING: 'expiring',
	// PTTL raced to -2 (or another unusable value) between the TYPE check and
	// the GET/PTTL calls — treat this source as unavailable for this pass
	// rather than as authoritative "absent" or a hard error.
	VANISHED: 'vanished',
});

export class ArgError extends Error {}

/* ------------------------------------------------------------------ */
/* Argument parsing / validation                                       */
/* ------------------------------------------------------------------ */

export function validateNamespace(ns) {
	if (typeof ns !== 'string' || ns.length === 0) {
		throw new ArgError('--namespace value must be a nonempty string.');
	}
	if (GLOB_CHARS.test(ns)) {
		throw new ArgError(`--namespace=${ns} contains glob characters ("*", "?", "[", "]"), which are not allowed.`);
	}
	if (!NAMESPACE_ALLOWLIST.includes(ns)) {
		throw new ArgError(`--namespace=${ns} is not in the approved allowlist: ${NAMESPACE_ALLOWLIST.join(', ')}`);
	}
	return ns;
}

export function validateLimit(rawValue) {
	const n = Number(rawValue);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new ArgError(`--limit must be a positive integer, got: ${JSON.stringify(rawValue)}`);
	}
	return n;
}

export function parseArgs(argv) {
	let apply = false;
	let overwriteLocal = false;
	let limitRaw = DEFAULT_LIMIT;
	const namespacesRaw = [];

	for (const raw of argv) {
		if (raw === '--apply') {
			apply = true;
			continue;
		}
		if (raw === '--overwrite-local') {
			overwriteLocal = true;
			continue;
		}
		if (raw.startsWith('--namespace=')) {
			namespacesRaw.push(raw.slice('--namespace='.length));
			continue;
		}
		if (raw.startsWith('--limit=')) {
			limitRaw = raw.slice('--limit='.length);
			continue;
		}
		throw new ArgError(`Unknown argument: ${raw}`);
	}

	if (namespacesRaw.length === 0) {
		throw new ArgError('At least one --namespace=<prefix> is required. Allowed values: ' + NAMESPACE_ALLOWLIST.join(', '));
	}

	const seen = new Set();
	const namespaces = [];
	for (const ns of namespacesRaw) {
		validateNamespace(ns);
		if (!seen.has(ns)) {
			seen.add(ns);
			namespaces.push(ns);
		}
	}

	const limit = validateLimit(limitRaw);

	return { apply, overwriteLocal, namespaces, limit };
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                   */
/* ------------------------------------------------------------------ */

export function sha256Hex(value) {
	return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Truncated digest for safe logging — never print full values/secrets. */
export function shortDigest(value) {
	return sha256Hex(value).slice(0, 12);
}

export function classifyTtlState(pttlMs) {
	if (pttlMs === -1) return TTL_STATE.PERSISTENT;
	if (typeof pttlMs === 'number' && pttlMs > 0) return TTL_STATE.EXPIRING;
	return TTL_STATE.VANISHED;
}

export function hostLabel(url) {
	try {
		return new URL(url).host;
	} catch {
		return 'unknown-host';
	}
}

/** Bounded, deduped SCAN across pages. `scanOnce(cursor, match, count)` must
 *  resolve to `{ cursor, keys }` and stops naturally when cursor === '0'. */
export async function scanBounded(scanOnce, prefix, limit) {
	const match = `${prefix}*`;
	let cursor = '0';
	const seen = new Set();
	const collected = [];
	do {
		const { cursor: nextCursor, keys } = await scanOnce(cursor, match, SCAN_COUNT);
		for (const key of keys || []) {
			if (seen.has(key)) continue;
			seen.add(key);
			collected.push(key);
			if (collected.length >= limit) return collected;
		}
		cursor = String(nextCursor);
	} while (cursor !== '0');
	return collected;
}

/* ------------------------------------------------------------------ */
/* Store adapters — local ioredis + two independent Upstash REST clients */
/* ------------------------------------------------------------------ */

export function createLocalStore() {
	const client = new IORedis(LOCAL_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
	return {
		label: 'local',
		host: hostLabel(LOCAL_REDIS_URL),
		async scanNamespace(prefix, limit) {
			return scanBounded(
				async (cursor, match, count) => {
					const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', count, 'TYPE', 'string');
					return { cursor: nextCursor, keys };
				},
				prefix,
				limit,
			);
		},
		async typeOf(key) {
			return client.type(key);
		},
		async getString(key) {
			return client.get(key);
		},
		async pttl(key) {
			return client.pttl(key);
		},
		async setNx(key, value, ttlState, pttlMs) {
			const res =
				ttlState === TTL_STATE.EXPIRING && typeof pttlMs === 'number' && pttlMs > 0
					? await client.set(key, value, 'PX', pttlMs, 'NX')
					: await client.set(key, value, 'NX');
			return res === 'OK';
		},
		/** Unconditional overwrite — only ever called by the explicitly
		 *  authorized --overwrite-local strategy, and only for keys already
		 *  confirmed absent/divergent relative to local. */
		async setOverwrite(key, value, ttlState, pttlMs) {
			const res =
				ttlState === TTL_STATE.EXPIRING && typeof pttlMs === 'number' && pttlMs > 0
					? await client.set(key, value, 'PX', pttlMs)
					: await client.set(key, value);
			return res === 'OK';
		},
		async quit() {
			await client.quit().catch(() => {});
		},
	};
}

export function createUpstashStore(label, url, token) {
	const client = new UpstashRedis({ url, token, automaticDeserialization: false });
	return {
		label,
		host: hostLabel(url),
		async scanNamespace(prefix, limit) {
			return scanBounded(
				async (cursor, match, count) => {
					const [nextCursor, keys] = await client.scan(cursor, { match, count, type: 'string' });
					return { cursor: nextCursor, keys };
				},
				prefix,
				limit,
			);
		},
		async typeOf(key) {
			return client.type(key);
		},
		async getString(key) {
			return client.get(key);
		},
		async pttl(key) {
			return client.pttl(key);
		},
		async setNx(key, value, ttlState, pttlMs) {
			const opts = { nx: true };
			if (ttlState === TTL_STATE.EXPIRING && typeof pttlMs === 'number' && pttlMs > 0) opts.px = pttlMs;
			const res = await client.set(key, value, opts);
			return res === 'OK';
		},
		/** Unconditional overwrite — only ever called by the explicitly
		 *  authorized --overwrite-local strategy, and only for keys already
		 *  confirmed absent/divergent relative to local. */
		async setOverwrite(key, value, ttlState, pttlMs) {
			const opts = {};
			if (ttlState === TTL_STATE.EXPIRING && typeof pttlMs === 'number' && pttlMs > 0) opts.px = pttlMs;
			const res = await client.set(key, value, opts);
			return res === 'OK';
		},
		async quit() {
			// REST client — no persistent connection to close.
		},
	};
}

/* ------------------------------------------------------------------ */
/* Per-key snapshot + reconciliation decision (pure, store-agnostic)     */
/* ------------------------------------------------------------------ */

/** Sequential (not Promise.all-across-stores) so a single run never fans out
 *  unbounded concurrent reads against any one backend. */
export async function snapshotKeyAcrossStores(stores, key) {
	const snapshots = [];
	for (const store of stores) {
		let type;
		try {
			type = await store.typeOf(key);
		} catch (err) {
			snapshots.push({ store: store.label, error: err?.message || String(err) });
			continue;
		}
		if (type === 'none') {
			snapshots.push({ store: store.label, exists: false, type: 'none' });
			continue;
		}
		if (type !== 'string') {
			// Never read/mutate non-string types — report and move on.
			snapshots.push({ store: store.label, exists: true, type, unsupported: true });
			continue;
		}
		let value;
		let pttlMs;
		try {
			value = await store.getString(key);
			pttlMs = await store.pttl(key);
		} catch (err) {
			snapshots.push({ store: store.label, error: err?.message || String(err) });
			continue;
		}
		if (value == null || pttlMs === -2) {
			// Vanished between TYPE check and GET/PTTL (concurrent expiry/delete).
			snapshots.push({ store: store.label, exists: false, type: 'none', vanished: true });
			continue;
		}
		snapshots.push({
			store: store.label,
			exists: true,
			type: 'string',
			value,
			pttlMs,
			ttlState: classifyTtlState(pttlMs),
			digest: shortDigest(value),
		});
	}
	return snapshots;
}

/**
 * Decide what (if anything) to do for one key given its per-store snapshots.
 * Never picks a winner among disagreeing sources — that is always reported
 * as a conflict for a human to resolve. (Used by the default safe strategy
 * only; the local-wins strategy has its own orchestration below because it
 * deliberately does pick a winner — local — by explicit user authorization.)
 */
export function planKeyReconciliation(snapshots) {
	const errored = snapshots.filter((s) => s.error);
	if (errored.length > 0) {
		return { action: 'error', errored };
	}

	const unsupported = snapshots.filter((s) => s.unsupported);
	if (unsupported.length > 0) {
		return { action: 'unsupported-type', unsupported };
	}

	const present = snapshots.filter((s) => s.exists);
	if (present.length === 0) {
		// Raced away everywhere since the scan; nothing to do this pass.
		return { action: 'noop' };
	}

	const [first, ...rest] = present;
	const consistent = rest.every((s) => s.digest === first.digest && s.ttlState === first.ttlState);
	if (!consistent) {
		return { action: 'conflict', present };
	}

	const missing = snapshots.filter((s) => !s.exists);
	if (missing.length === 0) {
		return { action: 'in-sync' };
	}

	return { action: 'copy', source: first, targets: missing.map((s) => s.store) };
}

/* ------------------------------------------------------------------ */
/* Namespace-level orchestration — default safe (no-overwrite) strategy */
/* ------------------------------------------------------------------ */

export async function reconcileNamespace({ stores, prefix, limit, apply }) {
	const keySets = [];
	for (const store of stores) {
		keySets.push(await store.scanNamespace(prefix, limit));
	}

	const union = [];
	const seenUnion = new Set();
	outer: for (const keys of keySets) {
		for (const key of keys) {
			if (seenUnion.has(key)) continue;
			seenUnion.add(key);
			union.push(key);
			if (union.length >= limit) break outer;
		}
	}

	const result = {
		prefix,
		scanned: Object.fromEntries(stores.map((s, i) => [s.label, keySets[i].length])),
		unionKeys: union,
		unionCount: union.length,
		copied: [],
		wouldCopy: [],
		concurrentSkips: [],
		conflicts: [],
		unsupported: [],
		errors: [],
		inSyncCount: 0,
	};

	// Sequential, one key at a time — bounded, predictable read/write cost.
	for (const key of union) {
		const snapshots = await snapshotKeyAcrossStores(stores, key);
		const plan = planKeyReconciliation(snapshots);

		if (plan.action === 'error') {
			result.errors.push({ key, details: plan.errored.map((s) => ({ store: s.store, error: s.error })) });
			continue;
		}
		if (plan.action === 'unsupported-type') {
			result.unsupported.push({ key, details: plan.unsupported.map((s) => ({ store: s.store, type: s.type })) });
			continue;
		}
		if (plan.action === 'conflict') {
			result.conflicts.push({ key, details: plan.present.map((s) => ({ store: s.store, digest: s.digest, ttlState: s.ttlState })) });
			continue;
		}
		if (plan.action === 'noop') {
			continue;
		}
		if (plan.action === 'in-sync') {
			result.inSyncCount += 1;
			continue;
		}

		// plan.action === 'copy'
		for (const targetLabel of plan.targets) {
			const targetStore = stores.find((s) => s.label === targetLabel);
			if (!apply) {
				result.wouldCopy.push({ key, from: plan.source.store, to: targetLabel, ttlState: plan.source.ttlState });
				continue;
			}
			try {
				const wrote = await targetStore.setNx(key, plan.source.value, plan.source.ttlState, plan.source.pttlMs);
				if (wrote) {
					result.copied.push({ key, from: plan.source.store, to: targetLabel });
					continue;
				}
				// NX no-op: something wrote this key concurrently. Re-check it — if
				// it now matches the source that's a safe concurrent skip; if not,
				// escalate to a conflict for a human rather than silently ignoring it.
				const [recheck] = await snapshotKeyAcrossStores([targetStore], key);
				if (recheck?.exists && !recheck.unsupported && recheck.digest === plan.source.digest && recheck.ttlState === plan.source.ttlState) {
					result.concurrentSkips.push({ key, store: targetLabel });
				} else {
					result.conflicts.push({
						key,
						details: [
							{ store: plan.source.store, digest: plan.source.digest, ttlState: plan.source.ttlState },
							{ store: targetLabel, digest: recheck?.digest ?? null, ttlState: recheck?.ttlState ?? null },
						],
					});
				}
			} catch (err) {
				result.errors.push({ key, details: [{ store: targetLabel, error: err?.message || String(err) }] });
			}
		}
	}

	return result;
}

/* ------------------------------------------------------------------ */
/* Namespace-level orchestration — LOCAL-WINS strategy (--overwrite-local) */
/* ------------------------------------------------------------------ */

/**
 * Local Redis is the authoritative source of truth. For every key that
 * exists locally as a string, each cloud store is written (overwritten)
 * only when it is absent or diverges (digest and/or TTL-state) from local
 * — a key already identical to local is never touched, minimizing writes.
 * Keys present only in the cloud (absent locally) are reported but never
 * modified or deleted: this strategy only ever pushes local -> cloud.
 * Non-string types are still never read or mutated on either side.
 */
export async function reconcileNamespaceLocalWins({ localStore, cloudStores, prefix, limit, apply }) {
	const stores = [localStore, ...cloudStores];
	const keySets = [];
	for (const store of stores) {
		keySets.push(await store.scanNamespace(prefix, limit));
	}

	const union = [];
	const seenUnion = new Set();
	outer: for (const keys of keySets) {
		for (const key of keys) {
			if (seenUnion.has(key)) continue;
			seenUnion.add(key);
			union.push(key);
			if (union.length >= limit) break outer;
		}
	}

	const result = {
		prefix,
		scanned: Object.fromEntries(stores.map((s, i) => [s.label, keySets[i].length])),
		unionCount: union.length,
		enforcedKeys: [], // keys where local had a usable string value (the set we verify after the run)
		written: [],
		wouldWrite: [],
		alreadySyncedCount: 0,
		cloudOnlyKeys: [], // present in cloud only — intentionally left untouched, not an error
		unsupported: [],
		errors: [],
	};

	// Sequential, one key at a time — bounded, predictable read/write cost.
	for (const key of union) {
		const snapshots = await snapshotKeyAcrossStores(stores, key);
		const [localSnap, ...cloudSnaps] = snapshots;

		if (localSnap.error) {
			result.errors.push({ key, store: localSnap.store, error: localSnap.error });
			continue;
		}
		if (localSnap.unsupported) {
			result.unsupported.push({ key, store: localSnap.store, type: localSnap.type });
			continue;
		}
		if (!localSnap.exists) {
			// No authoritative local value to enforce — leave this cloud-only key alone.
			result.cloudOnlyKeys.push(key);
			continue;
		}

		result.enforcedKeys.push(key);

		for (const cloudSnap of cloudSnaps) {
			if (cloudSnap.error) {
				result.errors.push({ key, store: cloudSnap.store, error: cloudSnap.error });
				continue;
			}
			if (cloudSnap.unsupported) {
				// Never overwrite a non-string type, even under local-wins.
				result.unsupported.push({ key, store: cloudSnap.store, type: cloudSnap.type });
				continue;
			}

			const alreadyInSync = cloudSnap.exists && cloudSnap.digest === localSnap.digest && cloudSnap.ttlState === localSnap.ttlState;
			if (alreadyInSync) {
				result.alreadySyncedCount += 1;
				continue;
			}

			if (!apply) {
				result.wouldWrite.push({ key, to: cloudSnap.store, ttlState: localSnap.ttlState, reason: cloudSnap.exists ? 'differs' : 'absent' });
				continue;
			}

			const targetStore = cloudStores.find((s) => s.label === cloudSnap.store);
			try {
				const wrote = await targetStore.setOverwrite(key, localSnap.value, localSnap.ttlState, localSnap.pttlMs);
				if (wrote) {
					result.written.push({ key, to: cloudSnap.store, reason: cloudSnap.exists ? 'differs' : 'absent' });
				} else {
					result.errors.push({ key, store: cloudSnap.store, error: 'overwrite SET did not return OK' });
				}
			} catch (err) {
				result.errors.push({ key, store: cloudSnap.store, error: err?.message || String(err) });
			}
		}
	}

	return result;
}

/** Post-run verification over the same bounded key set used during
 *  reconciliation. TTL comparison is by state (persistent vs expiring),
 *  never exact milliseconds. */
export async function verifyUnion(stores, keys) {
	const drift = [];
	for (const key of keys) {
		const snapshots = await snapshotKeyAcrossStores(stores, key);
		if (snapshots.some((s) => s.error)) {
			drift.push({ key, reason: 'error' });
			continue;
		}
		if (snapshots.some((s) => s.unsupported)) {
			drift.push({ key, reason: 'unsupported-type' });
			continue;
		}
		const missing = snapshots.filter((s) => !s.exists);
		if (missing.length > 0) {
			drift.push({ key, reason: 'absent', stores: missing.map((s) => s.store) });
			continue;
		}
		const [first, ...rest] = snapshots;
		const consistent = rest.every((s) => s.digest === first.digest && s.ttlState === first.ttlState);
		if (!consistent) {
			drift.push({ key, reason: 'conflict' });
		}
	}
	return drift;
}

/* ------------------------------------------------------------------ */
/* CLI entrypoint                                                        */
/* ------------------------------------------------------------------ */

function printUsage() {
	console.error(
		[
			'Usage:',
			'  node --env-file=.env.local .local/scripts/reconcile-upstash-mirrors.mjs --namespace=<prefix> [--namespace=<prefix> ...] [--limit=N] [--apply] [--overwrite-local]',
			'',
			`Allowed --namespace values: ${NAMESPACE_ALLOWLIST.join(', ')}`,
			'--limit must be a positive integer (default 500).',
			'--apply enables writes; omit it to run a read-only audit/preview.',
			'--overwrite-local switches to the local-wins strategy: local Redis overwrites',
			'  divergent/missing keys on DB1/DB2 (keys already identical to local are skipped).',
			'  Combine with --apply to write; without --apply it only previews the plan.',
		].join('\n'),
	);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`Argument error: ${err.message}`);
		printUsage();
		process.exitCode = 2;
		return;
	}

	const db1Url = process.env.UPSTASH_REDIS_REST_URL;
	const db1Token = process.env.UPSTASH_REDIS_REST_TOKEN;
	const db2Url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
	const db2Token = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;

	if (!db1Url || !db1Token) {
		console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN for DB1.');
		process.exitCode = 2;
		return;
	}
	if (!db2Url || !db2Token) {
		console.error('Missing UPSTASH_REDIS_REST_URL_MIRROR / UPSTASH_REDIS_REST_TOKEN_MIRROR (or legacy _2) for DB2.');
		process.exitCode = 2;
		return;
	}

	const localStore = createLocalStore();
	const db1Store = createUpstashStore('db1', db1Url, db1Token);
	const db2Store = createUpstashStore('db2', db2Url, db2Token);
	const cloudStores = [db1Store, db2Store];
	const stores = [localStore, ...cloudStores];

	console.log(
		JSON.stringify(
			{
				strategy: options.overwriteLocal ? 'local-wins' : 'safe-no-overwrite',
				mode: options.apply ? 'apply' : options.overwriteLocal ? 'preview' : 'audit',
				namespaces: options.namespaces,
				limit: options.limit,
				hosts: Object.fromEntries(stores.map((s) => [s.label, s.host])),
			},
			null,
			2,
		),
	);

	let exitCode = 0;
	const namespaceResults = [];

	try {
		if (options.overwriteLocal) {
			for (const prefix of options.namespaces) {
				const result = await reconcileNamespaceLocalWins({ localStore, cloudStores, prefix, limit: options.limit, apply: options.apply });
				if (result.unsupported.length > 0 || result.errors.length > 0) {
					exitCode = 1;
				}
				namespaceResults.push(result);
				console.log(
					JSON.stringify(
						{
							namespace: prefix,
							scanned: result.scanned,
							unionCount: result.unionCount,
							written: result.written.length,
							wouldWrite: result.wouldWrite.length,
							alreadySyncedCount: result.alreadySyncedCount,
							cloudOnlyKeys: result.cloudOnlyKeys.length,
							unsupported: result.unsupported,
							errors: result.errors,
						},
						null,
						2,
					),
				);
			}

			for (const result of namespaceResults) {
				// Only the keys local was authoritative for are verified; cloud-only
				// keys were intentionally left untouched and are not drift.
				const drift = await verifyUnion(stores, result.enforcedKeys);
				if (drift.length > 0) exitCode = 1;
				console.log(JSON.stringify({ verify: result.prefix, driftCount: drift.length, drift }, null, 2));
			}
		} else {
			for (const prefix of options.namespaces) {
				const result = await reconcileNamespace({ stores, prefix, limit: options.limit, apply: options.apply });
				if (result.conflicts.length > 0 || result.unsupported.length > 0 || result.errors.length > 0) {
					exitCode = 1;
				}
				namespaceResults.push(result);
				console.log(
					JSON.stringify(
						{
							namespace: prefix,
							scanned: result.scanned,
							unionCount: result.unionCount,
							copied: result.copied.length,
							wouldCopy: result.wouldCopy.length,
							concurrentSkips: result.concurrentSkips.length,
							conflicts: result.conflicts,
							unsupported: result.unsupported,
							errors: result.errors,
							inSyncCount: result.inSyncCount,
						},
						null,
						2,
					),
				);
			}

			for (const result of namespaceResults) {
				const drift = await verifyUnion(stores, result.unionKeys);
				if (drift.length > 0) exitCode = 1;
				console.log(JSON.stringify({ verify: result.prefix, driftCount: drift.length, drift }, null, 2));
			}
		}
	} finally {
		await localStore.quit();
	}

	if (exitCode !== 0) {
		console.error(
			options.apply
				? 'Reconciliation finished with unresolved conflicts/absences/errors — see drift above. Human review required.'
				: options.overwriteLocal
					? 'Preview found keys DB1/DB2 would need to have overwritten. Re-run with --apply --overwrite-local to write them.'
					: 'Audit found drift. Re-run with --apply to copy missing keys (conflicts still require manual review).',
		);
	} else {
		console.log('No drift detected across local/DB1/DB2 for the scanned namespaces.');
	}

	process.exitCode = exitCode;
}

const isMainModule = (() => {
	try {
		return import.meta.url === pathToFileURL(process.argv[1] || '').href;
	} catch {
		return false;
	}
})();

if (isMainModule) {
	main().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
