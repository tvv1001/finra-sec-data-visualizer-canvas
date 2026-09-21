# GEMINI.md — FINRA Network Graph

Concise onboarding for any AI working in this repo. Prefer current code + `.env.local` over older docs when they disagree.

## What this app is

Interactive relationship explorer for **FINRA BrokerCheck** and **SEC AdviserInfo** data (individuals, firms, control/employment links).

Stack: **Next.js 15 (App Router), React 19, D3 v7, Pixi.js 8, TypeScript, Redis**. Graph logic lives mainly in `src/lib/finra-graph.ts` / `src/components/FinraGraph.tsx`. Dashboard: `src/app/dashboard/`. Shared APIs: `src/app/api/finra/**`.

This app is a **PWA**. Prefer Redis when healthy (`USE_REDIS_ONLY=1`); when Redis cannot read/write, it **automatically runs cache-only** (process mem, primed/disk, `data/firm-connections/`, search sidecars, client visit-cache).

## Data layers (priority)

1. **`data/` (raw + derived)** — offline source of truth for imports/rebuilds, including `data/firm-connections/{id}.json` display fallback. Completeness is **not guaranteed**.
2. **Local Redis** (`redis://127.0.0.1:6379`, Commander UI `http://127.0.0.1:8081/`) — **main Redis DB on localhost** when `USE_LOCAL_REDIS=1`. Graph + dashboard share this store.
3. **Upstash cloud Redis** — production uses **dual DB** (DB1 + mirror) for load-balancing / failover. Leave `UPSTASH_REDIS_DISABLE_MIRROR` unset/`0` in Vercel. Never mutate cloud casually; sync/deploy only when the user asks.
4. **Search sidecars** (`data/national/search-index.*.json.gz` → `public/search-indexes/`) — gzip flatfiles for dashboard + graph search and CRD name hydration. Prefer sidecar `firm_name` over `Firm <CRD>` stubs. **Never store or query search indexes in Redis** (`search:indexes:*` is retired). See `docs/search-sidecar.md`.
5. **CRD inventory sidecar** (`data/crd-inventory.json.gz`) — coverage-valid unique firm|individual CRD census for cheap totals (no Redis SCAN). See `docs/crd-inventory-sidecar.md`.

**Production is reference-only** for agent work: read/audit OK; writes/deploys go `develop` → normal release. A shared production URL is **an example of the issue** — never deploy to Vercel from the agent, and never push local Redis to prod Redis unless the user explicitly instructs that sync. Details: `.github/instructions/prod-reference-workflow.instructions.md` and `.github/instructions/upstash-redis-and-crd-check.instructions.md`. Grok workflow: `/local-first-fix` (`.grok/workflows/local-first-fix.rhai`).

## Env flags (see `.env.local`)

| Flag | Role |
| --- | --- |
| `USE_LOCAL_REDIS=1` | Route Redis clients to local `127.0.0.1:6379` |
| `USE_REDIS_ONLY=1` | Prefer Redis when healthy; still degrade to disk/mem when Redis is unusable |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Cloud DB1 |
| `UPSTASH_REDIS_REST_URL_MIRROR` / `_TOKEN_MIRROR` | Cloud DB2 (optional; keep reconciled with DB1 + local) |
| `UPSTASH_REDIS_DISABLE_2` / `_DISABLE_MIRROR` | Disable dual-DB proxy (`1` = single DB only). Prod keeps this unset/`0` |
| `UPSTASH_ALLOW_WRITES` | Gate Redis writes (`1` to allow). Local usually `1`; prod is often `0` (read-mostly) |
| `REDIS_CACHE_ONLY=1` | Force cache-only (mem/disk/sidecars); for drills / emergencies |
| `EXTERNAL_API_DISABLED` | Block live FINRA/SEC fetches |
| `WRITE_NATIONAL` / `SCRAPE_FIRMS` | Offline crawl/write controls |

**Local `.env.local` (always — never point the local app at Upstash):**

```text
USE_LOCAL_REDIS=1
UPSTASH_ALLOW_WRITES=1
USE_REDIS_ONLY=1
```

**Production (Vercel) — dual Upstash:**

```text
USE_LOCAL_REDIS=0
UPSTASH_ALLOW_WRITES=0
UPSTASH_REDIS_DISABLE_MIRROR=0
USE_REDIS_ONLY=1
# + UPSTASH_REDIS_REST_URL / _TOKEN and UPSTASH_REDIS_REST_URL_MIRROR / _TOKEN_MIRROR
```

On **localhost**, HTTP/app/DB caching that would hide freshness issues should stay **off / short-lived** so dashboard and graph reflect Redis truth. Across graph + dashboard, **in-memory caching of shared payloads is encouraged** for UX (same dataset, fewer Redis round-trips).

## Performance & cost rules

- Optimize for **high throughput** and smooth graph interaction (large node sets).
- **Minimize Redis reads/writes** (Upstash cost + latency). Prefer process mem before Redis; cap firm-connections display enrichment; no `TYPE`-before-`SET`; avoid chatty scans on hot paths.
- Warm interactive paths should stay at **single-digit Redis commands** per page when mem misses (detail GETs + one firm-connections GET). Enrichment is capped (~40 lookups).
- When Redis errors/limits out → **cache-only automatically** (`src/lib/redisAvailability.ts`): firm connections fall back to `data/firm-connections/`; details use mem/primed/disk; search stays on sidecars. Do not open FINRA/SEC just because Redis failed.
- External FINRA/SEC validation is **slow and deliberate**, not on every click. Sequential crawl, respect 429 / `retry-after`. There are **no Vercel crons**.

## Graph ↔ dashboard contract

- Both surfaces use the **same Redis-backed person/firm data**.
- Dashboard middle pane **“Queue graph”** = dashboard selection history (`localHistory`).
- **“GRAPH CLICK HISTORY”** mirrors the graph’s `finra_selection_log` (localStorage).
- **Graph** button (back to the node graph): CRDs listed in **Queue graph** are passed via a **sessionStorage bridge** (`src/lib/queueGraphBridge.ts`) — **no query string**. Firm connection **Select → Done → Graph** also seeds `anchorFirmId` + people metadata so 100+ people (and gray employment links to that firm) inject in one shot without N individual detail fetches.
- Clicking **Graph** ends the current Queue graph session: dashboard selection history (`finra_dashboard_history`) is cleared immediately so the next visit to `/dashboard` starts a **new empty Queue graph**.
- Queue graph list has **no item cap** — show the full selection history.
- Shared selection helpers live around `collectSelectedNodeIdsForGraphHref` / `finra_selection_log` in `src/app/dashboard/page.tsx` and `src/lib/finra-graph.ts`.

## Click animation contract

Node-click reveal/spread may move the clicked node and newly revealed neighbors only. Settled nodes must stay frozen across subsequent clicks (no full-graph reheat, no full-canvas re-animate on incremental reveals).

## Commands

- `pnpm run dev` / `dev:clean` — local Redis + Next on `:4444`
- `pnpm run build` / `start` / `lint`
- `pnpm run test:unit` / `test:e2e` / `test:smoke`
- Ops/crawl/deploy one-offs: `.local/scripts/` (not wired in `package.json`). **Never create root-level `test-*.js` / `scrape-*.js`.** FINRA/SEC fetch+save → `.local/scripts/scrape.mjs`. Throwaway probes → `.local/test-scripts/` (gitignored). See `.github/instructions/local-scripts.instructions.md`.

## Where to look

| Area | Path |
| --- | --- |
| Graph behavior / animation | `src/lib/finra-graph.ts` |
| Graph UI shell | `src/components/FinraGraph.tsx` |
| Dashboard + Queue graph | `src/app/dashboard/page.tsx` |
| Redis client / dual DB | `src/lib/redisClient.ts` |
| Graph persistence | `src/lib/graphStore.ts` |
| Search / labels | `src/lib/localSearch.ts`, `docs/search-sidecar.md` |
| Inventory totals | `src/lib/crdInventorySidecar.ts`, `docs/crd-inventory-sidecar.md` |
| Copilot / scoped rules | `.github/copilot-instructions.md`, `.github/instructions/*` |

## Do / don’t

- **Do** keep local Redis, DB1, and DB2 reconciled when syncing; merge drift, don’t blind-overwrite unique live keys. When pushing bulk keys to Upstash, always use chunked `MSET` batching (e.g., via `.local/scripts/push_all_to_prod.mjs`) to minimize API requests.
- **Do** prefer Redis + sidecars + in-memory reuse over live upstream on interactive paths.
- **Do** keep crawl/validation sequential when you run it locally.
- **Do** update firm rosters from person pages only when writes are allowed (`UPSTASH_ALLOW_WRITES=1`) and Redis is usable: loading `/dashboard/individual/{crd}` upserts into each employer’s `firm-connections:firm:{id}` (skip-unchanged). No batch reverse-index job.
- **Do** serve firm people lists from Redis when healthy; if Redis is missing/unusable, fall back to `data/firm-connections/{id}.json`.
- **Don’t** treat incomplete `data/` as a blocker for Redis-only / PWA paths.
- **Don’t** write production Upstash unless the user explicitly requests deploy/sync.
- **Don’t** deploy to Vercel from an agent session. Don’t treat a prod URL as a deploy request.
- **Don’t** invent alternate ingestion paths; dashboard + `.local/scripts/scrape.mjs` own CRD intake. Don’t add parallel scrape/crawl one-offs at the repo root.
- **Don’t** create new root `test-*.js` / `scrape-*.js` / `crawl*.js`. Extend `.local/scripts/scrape.mjs` or place probes under `.local/test-scripts/`.
- **Don’t** put search indexes in Redis. Graph and dashboard search/name hydration use gzip sidecars only.
- **Don’t** write query-search hits (`?query=`) into `finra:*` / `sec:*` detail keys. Query search only collects CRDs.
- **Don’t** store a by-id `/search/{firm\|individual}/<CRD>` response under that host’s Redis prefix just because `hits.total > 0`. Gate with `hasFirmSourceCoverage` / `hasIndividualSourceCoverage` (`src/lib/sourceTruth.ts`). IA-only firm shells (e.g. CRD `155640`) belong on `sec:firm:*` only — not `finra:firm:*`. See `.github/instructions/finra-sec-api-patterns.instructions.md`.
- **Do** keep the app runnable in Redis **cache-only** when Redis reads/writes are disabled (`REDIS_CACHE_ONLY=1` or both Upstash DBs unusable): serve process mem, disk graph, `data/firm-connections/`, primed/search sidecars. `/api/finra/graph` returns compact layout nodes (no employment histories); detail stays on firm/individual routes.
- **Do** treat FINRA + SEC for the same firm/individual CRD as **one merged entity** on read (`finra:*` and `sec:*` keys stay separate in Redis; APIs/UI merge). Count unique `firm:{crd}` / `individual:{crd}`, not Redis key count.
- **Do** verify detail with both hosts using:
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?hl=true&wt=json`
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&includePrevious=true&wt=json`
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?hl=true&includePrevious=true&wt=json`
- **Do** treat Redis `firm-connections:firm:{id}` as the preferred dashboard/graph people roster. Firm detail stays small; `/connections` reads that key (with disk fallback when Redis is down).
- **Do** hard-cache fetched firm rosters in the client visit cache (memory + IndexedDB via `visitConnectionsKey`) for instant revisits; hydrate thin display fields from gzip search sidecars (`hydrateFirmConnectionsFromSearchSidecar`), not Redis detail GETs, on the light path.
