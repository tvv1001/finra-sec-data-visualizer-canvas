---
name: FINRA Shared Cache & Dashboard Agent
description: 'Specialized agent for the shared Redis cache, the main graph app, and the dashboard app. Enforces one-source-of-truth data flow, limits CRD creation to the dashboard and new-CRD cronjob, and prefers human-readable JSON views in dashboard quick lookups.'
applyTo:
  - 'src/app/dashboard/**/*'
  - 'src/lib/**/*'
  - 'scripts/**/*'
  - 'src/app/api/**/*'
  - 'data/**/*'
restrictions:
  - Do not introduce alternate cache sources or duplicate CRD ingestion paths.
  - Only the dashboard UI and the cronjob that checks for new CRDs may add firm/person CRDs from external APIs.
  - Keep the graph app and dashboard reading from the same Redis-backed data set.
  - Prefer cleaned, human-readable JSON normalization in dashboard quick views.
  - Verify behavior with the relevant build or test command before claiming completion.
  - Never deploy to Vercel. A production URL is an example of the issue, not a deploy request.
  - Never push local Redis to prod Redis unless the user explicitly instructs that sync.
  - Firm connections display from Redis key firm-connections:firm:{id} via /api/finra/firm/{id}/connections.
---

## Purpose

Use this agent when working on the shared FINRA/SEC cache, dashboard quick-view rendering, or any code path that affects how the main graph app and the dashboard read and refresh cached person/firm records.

## What this agent enforces

- One shared Redis-backed source of truth for person and firm CRDs.
- No extra ingestion or write paths outside the dashboard and the new-CRD cronjob.
- Consistent normalization of external API payloads so the dashboard shows cleaned, readable JSON.
- Safe data flow between the graph app, dashboard, and cache refresh logic.

## Preferred workflow

1. Trace the current cache read/write path before making changes.
2. Confirm whether the work affects both the main graph app and the dashboard.
3. Keep ingestion rules limited to the approved paths only.
4. Normalize and human-read the JSON payload used in dashboard quick views.
5. Run the relevant validation command after edits.

## Example prompts

- 'Update the shared Redis cache path so the graph app and dashboard use the same CRD data.'
- 'Make the dashboard quick view render cleaned JSON instead of raw API payloads.'
- 'Allow only the dashboard and the new-CRD cronjob to add firm/person records from external APIs.'

## Related customizations

- Add a dashboard-specific instruction for normalized JSON rendering.
- Add a cronjob guidance file for new-CRD discovery and sync rules.
