# Upstash Redis and CRD-Check Policy

Applies to: data crawler scripts, API cache helpers, build pipelines, and any code that reads/writes the app's runtime/derived data.

Summary

- **Updated policy (supersedes the original "Upstash-only" rule below)**: When running on `localhost`, this app always works against the **local Redis instance** (`redis://127.0.0.1:6379`, `USE_LOCAL_REDIS=1` in `.env.local`) as the primary read/write target. Local Redis reads are also used to compare against cloud data. Deploying/pushing updates from local to the two Upstash cloud databases (production) is a deliberate, user-directed action — never an automatic side effect of local development or routine agent tasks.
- There are **two Upstash cloud Redis databases** kept in sync as mirrors of each other (see "Dual cloud DB" section below). Both must be kept reconciled with each other and with local Redis's canonical dataset.
- When a task or script needs to "check for new CRDs" or look for updated CRDs, it MUST search for the highest CRD numbers first and proceed descending. This preference applies to both discovering new CRDs and detecting updates to existing CRDs.

## Local-first policy (current)

- Default to local Redis for all reads/writes during local development and routine debugging. Do not write to the cloud Upstash databases unless the user explicitly instructs a deploy/push/sync-to-prod action. A production URL is only an example of a bug; it is not permission to sync Redis or deploy Vercel.
- Local Redis reads are safe at any time for comparing/validating against cloud data (read-only diagnostics).
- Only push local → cloud (or flush/replace cloud data) when the user explicitly asks for a deploy/sync/migration step. Always confirm before any destructive operation (`FLUSHALL`, bulk overwrite) on a cloud DB.

## Dual cloud DB reconciliation (two Upstash databases)

This app (and the sibling `dashboard-crds` app — see cross-app note below) writes to **two separate Upstash Redis databases** treated as mirrors:
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — primary (DB1)
- `UPSTASH_REDIS_REST_URL_MIRROR` / `UPSTASH_REDIS_REST_TOKEN_MIRROR` — mirror (DB2)

These two databases can silently drift apart over time (e.g. a dual-write path fails on one side, or a serverless read auto-caches into only one DB). When reconciling:
- Never assume one side is authoritative by default — compare key sets (`SCAN`) across local, DB1, and DB2 first.
- **Merge, don't overwrite blindly.** Keys present only on one cloud DB (e.g. freshly fetched `finra:firm:<CRD>`, `firm-connections:firm:<CRD>` rosters) are real data, not garbage — pull them into local and the other cloud DB rather than deleting them. Never do that merge unless the user asked for a Redis sync.
- Keys present only in local (e.g. manually-added `non-live-crds:*` keys) should be pushed to both cloud DBs so all three stay consistent. Legacy `owner-ref:*` is retired — delete it; do not sync or rewrite it.
- **Batching and performance**: When explicitly pushing local Redis keys to production Upstash servers (e.g., via `push_all_to_prod.mjs` or similar syncs), group keys into chunks of ~100 and use `MSET` (multiple set) over the REST API instead of individual `SET` commands. This dramatically reduces the number of API calls, speeds up the sync, and minimizes Upstash command charges.
- After reconciliation, verify with an exact key-count match across all three stores (local, DB1, DB2) plus spot-checks of specific keys (byte-for-byte value comparison, not just presence).
- Chunk large single-command payloads (e.g. big hash `HSET`s with thousands of fields) into sub-batches of ~500 fields before writing to Upstash — a single oversized command can exceed Upstash's 10MB REST request-size limit even with pipeline-level batching.

1. Upstash-only Redis (legacy rule — production/CI paths only)
   - Production (Vercel) and CI data-sync flows must use Upstash REST endpoints only — this still applies to the deployed app itself, which has no access to the developer's local Redis.
   - Expect these environment variables to exist and be used when interacting with Upstash:
     - `UPSTASH_REDIS_REST_URL` (the REST URL)
     - `UPSTASH_REDIS_REST_TOKEN` (the auth token)
   - Do not check in credentials. If a .env or secrets placeholder is needed, create a `.env.example` with placeholder keys and document how to set real secrets in CI/hosting.

     1.a Runtime data source prohibition
     - Runtime processes (cron jobs, schedulers, serverless functions, API routes that perform discovery) MUST NOT fall back to a local raw data directory as a source of truth. The local raw import (for example the sibling `../Data-finra-sec/data/raw/` directory) is a read-only external import used for offline rebuilds and must not be used by scheduled or on-demand runtime discovery flows.
     - If a script needs to seed or rebuild from the local raw import, do that in an explicit import step (e.g. `scripts/build_primed_from_raw.js`) that runs as a controlled job and updates Upstash-backed caches. Runtime jobs must use Upstash as the canonical source during execution.

## Firm connections data flow (individual↔firm rosters)

- A firm's "current/previous connections" (the roster of individuals employed there) is computed by `getFirmConnectionsFromGraph()` in `src/lib/graphConnections.ts`.
- **Priority source (local Redis only)**: `getConnectionsFromBrokerIdMirror()` reads the broker-id mirror keys — `sec:firm:<CRD>_brokers:current`, `sec:firm:<CRD>_brokers:previous`, `finra:firm:<CRD>_brokers:current`, `finra:firm:<CRD>_brokers:previous` — and, if any of them contain data, treats that CRD list as the authoritative roster ahead of every other source below. This lookup must only ever be served from the **local Redis instance** (`redis://127.0.0.1:6379`, i.e. only when `USE_LOCAL_REDIS=1` routes reads there) — never from the cloud Upstash DBs. These keys hold plain CRD-id arrays (no names), so results are enriched with names/dates from `getConnectionsFromGraphStore()` where the graph store already has that person hydrated.
- **Primary source (when the mirror above is empty)**: the official FINRA/SEC individual-by-firm search endpoints — these are the authoritative roster source and must be used first:
  - `https://api.brokercheck.finra.org/search/individual?firm=<CRD>&includePrevious&hl=true`
  - `https://api.adviserinfo.sec.gov/search/individual?firm=<CRD>&includePrevious`
- **Supplementary rule**: a connection can also be established purely because an individual's own detail record lists that firm CRD as a current/previous employer — even if the official firm-roster search missed that person (pagination gaps, rate limits, etc.). Graph-derived reverse links (from `getConnectionsFromGraphStore()`, which scans individual↔firm employment edges already present in the persisted graph) must always be merged in alongside the official roster results, not used only as a fallback when the official search is empty.
- Display roster is Redis `firm-connections:firm:<CRD>` (local when `USE_LOCAL_REDIS=1`). Dashboard and graph load it via `/api/finra/firm/<CRD>/connections`. Do not inline that roster into `?merged=1` firm detail. Disk `data/firm-connections/<CRD>.json` is a local compute artifact, not the UI source. Push that key to cloud Redis only when the user explicitly asks.

## Broker-id mirror keys (`{finra|sec}:firm:<CRD>_brokers:current|previous`)

- These keys are actively read (local-Redis-only, see above) as the top-priority firm-connections source, and are also written by `persistBrokerIdLists()` in `src/lib/graphConnections.ts` (and, for pre-existing firms, by the standalone script `scripts/update_sec_brokers.mjs`) as a mirror for the sibling `dashboard-crds` app.
- Do not add code that reads these keys from a **cloud** Upstash DB — only local Redis. If a future task needs this roster on Vercel/production, that requires an explicit separate decision (not an automatic extension of this rule).

2. CRD discovery ordering
   - Any code that says or implies "check for new CRDs" must:
     - Attempt to find the highest CRD numbers first (descending order). This reduces scan work for newly minted high-number CRDs and surfaces recent additions/updates faster.
     - When scanning ranges or batches, prefer fetching ranges like `MAX..MIN` (descending) or explicitly sort results by CRD number descending.
     - When deciding whether a CRD is new vs updated, compare the remote Upstash-cached record metadata (e.g., updated_at, version) and prioritize newer CRD numbers first for efficiency.
   - Discovery vs detail are separate steps:
     - Query search (`?query=`) only builds a CRD candidate list.
     - Detail must be fetched with by-id URLs (`/search/firm/<CRD>?hl=true&wt=json` and `/search/individual/<CRD>?hl=true&includePrevious=true&wt=json` on both hosts) and stored under `finra:*` / `sec:*` only after source-coverage validation. See `.github/instructions/finra-sec-api-patterns.instructions.md` — do not reintroduce false cross-source shells (e.g. IA-only firms under `finra:firm:*`).

3. Scan strategy guidance
   - For large spaces of numeric CRDs, implement an exponential/backoff probing approach: probe high-number checkpoints first (e.g., current_max, current_max - step, ...), then narrow range if necessary.
   - Prefer batched requests that return ordered results when possible, and always request the server or index to sort by CRD descending if supported.

4. Implementation guidance (examples)
   - Scripts under `scripts/` that crawl or rebuild caches should read Upstash creds from env and use the project's existing Redis helper functions.
   - Example pseudo-pattern:
     - Fetch `current_max_crd = get_cached_max_crd()`
     - For i from current_max_crd down to 1 step N: check CRD i..i-N+1 in descending order
     - If remote API supports sorting, request `sort=crd_desc` and process results in returned order

5. Testing & CI
   - Tests or CI jobs that simulate cache interactions should mock Upstash REST endpoints rather than requiring a live Redis instance.
   - If an integration job needs real Upstash access, use dedicated test credentials stored in the CI secret store and scoped to a test namespace.

Notes

- This is a project-level policy to standardize data-sync behavior and performance when discovering CRDs. If an exception is required (for a one-off migration, for example), open a short PR describing why and how the exception will be cleaned up.

## Cross-app note: shared Redis with `dashboard-crds`

The sibling app at `../dashboard-crds` reads and writes the **exact same local Redis instance** (`redis://127.0.0.1:6379`) and the **exact same two Upstash cloud databases** (same `UPSTASH_REDIS_REST_URL`/`_MIRROR` credentials) as this repo. Any local-Redis-first policy change, cloud DB reconciliation, or new/removed key pattern documented here also applies to and affects that app. See `../dashboard-crds/GEMINI.md` for that app's own Redis/cache documentation, which should be kept in sync with this file when shared conventions change.

Contact

- If you have questions about how an existing script should be migrated to follow this rule, open an issue or ping the maintainer in the PR description and reference this file.
