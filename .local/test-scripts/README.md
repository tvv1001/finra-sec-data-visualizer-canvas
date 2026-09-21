# Ad-hoc test / probe scripts (gitignored)

Put throwaway Redis/API/Puppeteer probes here — **not** in the repo root.

- Gitignored via `/.local/*` (except `.local/scripts/`).
- Do **not** add root-level `test-*.js` / `scrape-*.js`.
- Durable unit/e2e tests stay in `tests/`.
- External FINRA/SEC fetch + Redis/raw write: use **`.local/scripts/scrape.mjs`** only.
