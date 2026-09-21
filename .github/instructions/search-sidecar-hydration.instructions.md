---
name: Search Sidecar Hydration
description: "Use when hydrating graph nodes, firm labels, search, expand, or deployment search indexes. The gzip search-index sidecars are the app-wide name/identity catalog."
applyTo:
  - 'src/lib/localSearch.ts'
  - 'src/lib/finra-graph.ts'
  - 'src/lib/searchDataPaths.ts'
  - 'src/app/api/finra/**'
  - 'scripts/build_search_indexes.js'
  - 'scripts/copy-search-indexes.js'
  - 'README.md'
  - 'GEMINI.md'
  - 'docs/search-sidecar.md'
---

# Search sidecar hydration

The gzip search-index flatfiles are the catalog used to hydrate this app.

Canonical files:

- `data/national/search-index.finra.firm.json.gz`
- `data/national/search-index.finra.individual.json.gz`
- `data/national/search-index.sec.firm.json.gz`
- `data/national/search-index.sec.individual.json.gz`

Build copies them to `public/search-indexes/` for runtime. `src/lib/localSearch.ts` loads those gzip sidecars first (then Redis) for search, expand, and CRD→name lookup.

## Firm labels

- Never ship or keep a canvas firm label as `Firm <CRD>` or `Node firm:<CRD>` once the sidecar has `firm_name`.
- Look up missing firm names from the sidecar by CRD (`lookupFirmNamesFromSearchSidecar` / `hydrateFirmNodeLabelsFromSearchSidecar`).
- Cache the real name on the node (`label`, `firmName`, `basicInformation.firmName`) and in `finra_node_label_cache`.
- Never replace a real firm name with a longer generic placeholder during graph merges.

## Do not

- Do not treat live FINRA/SEC detail fetches as the first source of display names for nodes fetched onto the graph.
- Do not block sidebar Form BD loading on employee-roster `includeConnections=1`.
- Do not edit sidecar files by hand; rebuild with `scripts/build_search_indexes.js` and copy with `scripts/copy-search-indexes.js`.
