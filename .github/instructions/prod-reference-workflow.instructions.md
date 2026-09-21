---
name: Prod Reference Only Workflow
description: 'Use when touching data refresh, cache/graph rebuild, deployment prep, or any task that can affect production data/state. Enforces read-only production reference and branch-first promotion workflow.'
applyTo:
  - 'src/**'
  - 'scripts/**'
  - 'data/**'
  - 'README.md'
  - '.github/copilot-instructions.md'
  - '.github/workflows/**'
---

# Production reference and promotion workflow

Treat production as a **read-only reference source** for verification.

## Hard rules (all agents: Grok, Gemini, Copilot, Cursor)

- A production URL (for example `https://finra-data-chart-next-02.vercel.app/...`) is **an example of the issue**, not a request to change production.
- **Never deploy to Vercel** from an agent session (`vercel deploy`, `pnpm run vercel:deploy`, GitHub deploy buttons, or equivalent).
- **Never push local Redis to prod Redis** (Upstash DB1/DB2) unless the user explicitly says to sync/push/deploy Redis. A bug report, a prod URL, or “it works locally” is not that instruction. When an explicit push is requested, use batched `MSET` logic (like `.local/scripts/push_all_to_prod.mjs`) rather than individual sets to reduce API commands.
- Local app writes (`USE_LOCAL_REDIS=1`) stay on `127.0.0.1:6379` only. Do not add dual-write / replica hooks that silently update Upstash.

## Required behavior

- Do **not** directly update production data/state from agent tasks.
- Do **not** run direct prod mutation/deploy operations as part of routine fixes.
- Use production endpoints only to validate, compare, or audit behavior/data.
- Implement code/data changes in this repo first, against **local Redis**.
- Route all release changes through the `develop` branch workflow.
- Production promotion is performed only after branch-based validation and **user-controlled** release steps.

## Operational guidance

- Safe on prod: GET/read-only checks, audits, parity validation, and diagnostics.
- Unsafe on prod: write, reset, purge, upsert, deploy, Vercel publish, or Redis mutation.
- If a task appears to require a direct prod update, stop and switch to a branch-first plan:
  1. prepare the fix locally (code + local Redis),
  2. verify on `http://localhost:4444`,
  3. commit/push to `develop` only if the user asked for git,
  4. wait for the user to promote to production / sync Redis.

## Firm connections

Display roster is Redis `firm-connections:firm:{id}` via `/api/finra/firm/{id}/connections`. Do not inline that roster into firm detail JSON. Do not recompute it on every dashboard load when the key already exists.

## Communication requirement

When discussing deployment/data steps, state that production is reference-only, that a shared prod URL is an example, and that Vercel deploys and Redis pushes happen only when the user instructs them.
