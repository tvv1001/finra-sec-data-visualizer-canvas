# CRD inventory sidecar

Cheap local census of **coverage-valid** unique `firm|individual` CRDs (real detail pages only). Use this instead of Redis SCAN / per-key reads for inventory totals.

## File

- `data/crd-inventory.json.gz`

```json
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "counts": { "people": 61138, "firms": 14498, "unique": 75636 },
  "firms": [149018, 305],
  "individuals": [8121845, 4962493]
}
```

FINRA+SEC for the same `type:crd` collapse to one ID. Names live in search-index sidecars; `data/crd-log.json` stays the capped MRU name list.

## Update path

- Dashboard `fetch-crds` after a new coverage-valid entity is saved
- Firm / individual detail routes when coverage is confirmed
- Rare full rebuild: `node .local/scripts/reconcile-cached-crd-count.mjs --apply` (or `--sidecar-only --apply`)
- Also rebuilt at the end of `.local/scrape/sync_redis_details_to_raw.js --apply`

## Deploy

Vercel excludes `/data/**` by default. Keep these opted back in via `.vercelignore`:

- `!/data/crd-inventory.json.gz`
- `!/data/crd-log.json`

Without the gzip on the deployment filesystem, the dashboard falls back to Redis `dashboard:cached-crd-count` (easy to leave stale after bulk imports).

## Read path

Dashboard **Redis CRDs** total (and people/firms) always comes from sidecar `counts` when `data/crd-inventory.json.gz` exists:

- `list-cache-cards` → `inventoryTotals.unique` / `cachedCrdCount`
- `get-inventory-counter` → sidecar `unique`

Redis `dashboard:cached-crd-count` is fallback only if the gzip is missing. Do not SCAN Redis just to display totals.
