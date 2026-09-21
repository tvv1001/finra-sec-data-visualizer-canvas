---
name: FINRA SEC API Pattern Guidelines
description: "Use when editing FINRA BrokerCheck or SEC AdviserInfo API routes, crawler scripts, graph/sidebar code that links to upstream records, or docs/prompts that describe this app's external API patterns. Covers validated detail endpoints, search endpoints, placeholder usage, and cache naming."
applyTo:
  - 'src/app/api/finra/**'
  - 'scripts/**'
  - '.local/scripts/**'
  - 'src/lib/finra-graph.ts'
  - 'src/lib/finra-graph/**/*.ts'
  - 'src/lib/sourceTruth.ts'
  - 'src/lib/hydration.ts'
  - '.github/copilot-instructions.md'
  - '.github/SKILL.md'
  - 'README.md'
  - 'GEMINI.md'
---

When working from `data/raw/` or the external imported raw set:

- On VS Code / Copilot startup for this repository, first check for the latest external import at `../Data-finra-sec/data/raw/`.
- If that external raw directory exists, prefer it as the freshest import source before relying on this repo's local `data/raw/`.
- For data refresh, graph rebuild, primed bundle, search-index, or deploy-prep tasks, sync from that external raw directory into this repo's `data/raw/` first.
- After syncing into `data/raw/`, rebuild the local derived artifacts needed to prep a Redis-backed deployment, including graph outputs and deployment bundle inputs.
- Treat the imported raw directory as read-only; never edit it in place.
- Prefer the imported raw files when validating upstream shape or history coverage, then update derived repo data separately.
- For record inventory tasks, check both top-level individual and firm CRDs, and use `previousEmployments` / `previousIAEmployments` for individuals and `registrations` for firms.
- When syncing or rebuilding derived caches, use append-safe logic that skips records already present instead of assuming a full rebuild.
- If a task involves docs or prompts, describe the source as the latest source of truth and avoid implying that local derived caches are canonical.

Graph node display names are hydrated from the gzip search-index sidecars (`data/national/search-index.*.json.gz` → `public/search-indexes/`), not from live upstream detail as the first pass. Firm labels must keep sidecar `firm_name` values and must not revert to `Firm <CRD>` after a later merge. See `docs/search-sidecar.md`.

# FINRA / SEC API pattern guidelines

This instruction supplements `.github/copilot-instructions.md` for work that touches upstream FINRA BrokerCheck and SEC AdviserInfo integrations.

## Script entrypoint (required for agents)

- **Canonical scrape:** `npx tsx --env-file=.env.local .local/scripts/scrape.mjs` (`fetch` | `search` | `backfill`).
- Do **not** create new root-level scrape/test JS. See `.github/instructions/local-scripts.instructions.md`.
- Gap scanning remains `.local/scripts/gap_scan_top_crds.mjs` (specialized).

## Critical mistake to avoid (false / cross-source data)

**Do not treat “API returned `hits.total > 0`” as proof that a CRD belongs on that host.**

Both BrokerCheck and AdviserInfo expose by-id URLs under `/search/.../<CRD>`. A host can still return a thin or mirrored shell that is **not** real coverage for that source. Storing those shells under the wrong Redis prefix floods local Redis with false nodes (example: IA-only firm `155640` OBEL FINANCIAL ADVISORS stored as `finra:firm:155640` even though it has no BrokerCheck BD coverage — keep `sec:firm:155640` only).

### Two-step pipeline (required)

1. **Collect CRDs only** with query search (list / discovery). Never write query-hit rows into `finra:*` / `sec:*` detail keys.
2. **Verify + store detail** with the by-id URLs below, then **gate on source coverage** before writing Redis.

### Query search (CRD collection only)

- `https://api.brokercheck.finra.org/search/firm?query=<QUERY>`
- `https://api.brokercheck.finra.org/search/individual?query=<QUERY>`
- `https://api.adviserinfo.sec.gov/search/firm?query=<QUERY>`
- `https://api.adviserinfo.sec.gov/search/individual?query=<QUERY>`

Query hits are flat list fields (`firm_source_id` / `firm_name`, `ind_*`, etc.). Use them only to build a CRD set. Do not cache the query response as firm/individual detail.

### Detail fetches by CRD (canonical)

Use these exact patterns (placeholders, not baked-in IDs):

- Firm:
  - `https://api.adviserinfo.sec.gov/search/firm/<CRD>?hl=true&wt=json`
  - `https://api.brokercheck.finra.org/search/firm/<CRD>?hl=true&wt=json`
- Individual:
  - `https://api.adviserinfo.sec.gov/search/individual/<CRD>?hl=true&includePrevious=true&wt=json`
  - `https://api.brokercheck.finra.org/search/individual/<CRD>?hl=true&includePrevious=true&wt=json`

FINRA detail payloads typically embed JSON in `_source.content`. SEC detail payloads typically embed in `_source.iacontent` (object or string). Empty `hits`, orphans, parse failures, and query-flat `_source` shapes are junk — do not store them.

### Source coverage gate (before Redis write)

After a by-id fetch, decide the Redis key from **coverage**, not from which URL you called:

| Redis key | Keep only when |
| --- | --- |
| `finra:firm:<CRD>` | Firm has BrokerCheck / BD coverage (`bcScope` in-scope, or legacy/BD signals such as `firmStatus`, registrations, `bdSECNumber`, etc.) |
| `sec:firm:<CRD>` | Firm has AdviserInfo / IA coverage (`iaScope` in-scope or SEC IA signals such as notice filings / brochures / IA SEC number) |
| `finra:individual:<CRD>` | Individual has FINRA coverage (`bcScope` not `NotInScope`, or FINRA registrations / BC employments / exams) |
| `sec:individual:<CRD>` | Individual has SEC coverage (`iaScope` not `NotInScope`, or IA employments / IA disclosures / IA state regs) |

Implementation source of truth: `hasFirmSourceCoverage` / `hasIndividualSourceCoverage` in `src/lib/sourceTruth.ts` (and related empty-shell helpers in `src/lib/dashboard-detail.ts`).

Hard rules:

- IA-only firm shells (`isIAFirm: "Y"`, active `iaScope`, **no** `bcScope` / BD fields) → **SEC only**, never `finra:firm:*`.
- Broker-only individuals (`iaScope: "NotInScope"` with no IA history) → **FINRA only**, never `sec:individual:*`.
- IA-only individuals (`bcScope: "NotInScope"` with IA activity) → **SEC only**, never `finra:individual:*`.
- Check **both** hosts for every CRD; a CRD may exist on FINRA, SEC, both, or neither.
- Compare stored content to the live by-id response (name + CRD id + scope) when auditing; delete mismatched or no-coverage keys rather than “fixing” them as present.

## Use placeholders, not baked-in examples

When writing docs, prompts, or instructions:

- Prefer placeholders such as `<CRD>`, `<QUERY>`
- Do not bake in misleading examples like `query=smith` unless the example is intentionally demonstrating a human search term.
- Use `https` in examples unless documenting a specific legacy compatibility case.

Placeholder meanings:

- `<CRD>`: individual or firm CRD / source identifier
- `<QUERY>`: free-text term or blank string where the upstream endpoint supports it
- `<FIRM_PREFIX>`: adviser firm-name prefix used by SEC individual search-by-firm flows

## Keep route defaults aligned with the existing app

When adding or editing route helpers, preserve the defaults already used by this app unless the task explicitly changes them:

- `start=0` for search routes
- `includePrevious=true` for individual detail enrichment unless intentionally disabled
- saved detail payloads in `data/raw/` should use source-specific wrapper shapes: FINRA `{ "content": <normalized detail payload> }`, SEC `{ "iacontent": <normalized detail payload> }`

Avoid inventing alternate naming schemes in docs or scripts unless the task explicitly includes a migration.

## Keep functional docs strictly aligned with the current working state

When updating `README.md`, repo instruction files, or prompts that describe graph functionality:

- treat the current runtime implementation as the source of truth
- validate behavior against the relevant code paths before documenting it
- avoid documenting intended behavior unless that behavior is already implemented and verified

If the implementation and docs disagree, update the docs to match the verified current behavior unless the task explicitly requires changing the implementation too.
