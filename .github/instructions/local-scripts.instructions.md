---
name: Local scripts and scrape/test placement
description: "Where AI agents must put scrape/crawl/test one-offs. Use .local/scripts/scrape.mjs for FINRA/SEC fetch+save; never create new root-level test-*.js or scrape-*.js."
applyTo:
  - '.local/scripts/**'
  - '.local/test-scripts/**'
  - 'scripts/**'
  - 'GEMINI.md'
  - '.github/copilot-instructions.md'
  - '.github/instructions/finra-sec-api-patterns.instructions.md'
  - 'README.md'
---

# Local scrape / test scripts (required)

## Do not create

- Root-level `test-*.js`, `test_*.js`, `scrape*.js`, `crawl*.js`, `unwrap.js`
- New one-off FINRA/SEC fetch scripts that duplicate Redis/`data/raw` write logic

## Use instead

| Need | Path |
| --- | --- |
| Fetch CRD by id → Redis + `data/raw/` | `.local/scripts/scrape.mjs fetch --kind=… --crd=…` |
| Search terms then save new CRDs | `.local/scripts/scrape.mjs search --target=N` |
| Dump Redis envelopes to disk | `.local/scripts/scrape.mjs backfill --crd=…` |
| Gap scan top CRD window | `.local/scripts/gap_scan_top_crds.mjs` (specialized; keep using) |
| Push local Redis → Upstash | `.local/scripts/push_all_to_prod.mjs` |
| Throwaway probes | `.local/test-scripts/` (gitignored except README) |
| Real automated tests | `tests/unit/`, `tests/e2e/` |

```bash
npx tsx --env-file=.env.local .local/scripts/scrape.mjs help
npx tsx --env-file=.env.local .local/scripts/scrape.mjs fetch --kind=firm --crd=343853
```

## Coverage gate

Still required before writing `finra:*` / `sec:*`: `hasFirmSourceCoverage` / `hasIndividualSourceCoverage` from `src/lib/sourceTruth.ts`. See `finra-sec-api-patterns.instructions.md`.

## If you must add a durable helper

Put it under `.local/scripts/`, prefer extending `scrape.mjs` with a subcommand over a new parallel scraper.
