# Active scripts (day-to-day only)

Nuclear keep-list: only what `pnpm dev` / `pnpm build` / tests need, plus approved ops entrypoints below.

**AI rule:** do not create root-level `test-*.js` / `scrape-*.js`. Use scripts here. Throwaway probes → `../test-scripts/` (gitignored).

## Master scrape (FINRA/SEC → Redis + data/raw)

- **`scrape.mjs`** — canonical fetch / search / backfill
  - `npx tsx --env-file=.env.local .local/scripts/scrape.mjs help`
  - `… scrape.mjs fetch --kind=firm --crd=343853`
  - `… scrape.mjs search --target=10`
  - `… scrape.mjs backfill --crd=343853`

Specialized (keep; do not duplicate):

- `gap_scan_top_crds.mjs` — probe missing CRDs in the top window
- `push_delta_to_prod.mjs` — **preferred** quota-friendly batched MSET (e.g. `--match='firm-connections:firm:*' --batch=50 --sleep=150`)
- `push_all_to_prod.mjs` — full DB dump via MSET (avoid unless necessary; burns Upstash read/write quota)

## Dev
- `start-local-redis.sh` — used by `pnpm dev` / `pnpm dev:clean`

## Build (`pnpm build` / `prebuild`)
- `prebuild.js` — Next prebuild hook
- `build_workers.js` — pure JS `d3-force` worker bundle
- `build_search_indexes.js`, `copy-search-indexes.js` — search sidecars → `public/search-indexes/`
- `build_primed_cache_bundle.js` — primed cache (prebuild when raw caches exist)
- `build_graph_from_cache.js` — local graph artifact when needed
- `fetch_graph_from_server.js` — optional remote graph sync from prebuild

## E2E
- `run-e2e-docker.sh`, `run-e2e.README.md`
- Smoke includes `tests/e2e/firm-connection-bidirectional.spec.ts`: opens a person page, asserts every employer firm’s `firm-connections` roster includes that person CRD, and reports roster count drift vs `tests/e2e/fixtures/firm-connection-counts.{crd}.json`. Re-baseline with `UPDATE_FIRM_CONNECTION_SNAPSHOT=1`; hard-fail on drift with `FIRM_CONN_STRICT_COUNTS=1`.

## Other ops
Long-running crawlers (`parallel_crawler.js`, `continuous_*.js`, `crawl_external.js`, etc.) remain here for rare use — prefer **`scrape.mjs`** for normal CRD intake.
