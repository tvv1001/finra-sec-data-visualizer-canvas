# Testing Strategy

This document defines a practical testing strategy for the FINRA Network Graph application.

It is designed for the current architecture:

- **Next.js 15** app router
- **React 19** client UI in `src/components/FinraGraph.tsx`
- **D3-driven graph runtime** in `src/lib/finra-graph.ts`
- **Server routes** under `src/app/api/finra/**`
- **Data build / crawl scripts** under `scripts/**`
- **Generated graph and cache artifacts** under `data/**`

The goal is to cover the main parts of the application with the right level of testing instead of trying to force every behavior into one test style.

---

## Goals

1. Catch regressions in the graph interaction model
2. Protect FINRA / SEC data normalization and merge behavior
3. Validate API route behavior with realistic local fixtures
4. Keep artifact-generation scripts trustworthy
5. Add confidence incrementally without over-engineering the test stack

---

## Guiding principles

- Prefer **small, deterministic tests** for pure logic
- Use **integration tests** for route handlers and storage behavior
- Use **browser tests** only for flows that truly depend on DOM, D3, or user interaction
- Avoid brittle visual assertions when class/state assertions are enough
- Test the repo's **highest-risk behaviors first**:
  - graph selection/highlight/trace state
  - merged FINRA/SEC detail behavior
  - graph/store persistence and reset flows
  - build scripts that generate deploy-time artifacts

---

## Recommended testing layers

### 1. Unit tests

Use unit tests for pure or mostly-pure modules.

**Recommended tool:** `Vitest`

**Best targets in this repo:**

- `src/lib/finra-graph/detailUtils.ts`
- `src/lib/finra-graph/formatters.ts`
- `src/lib/dataMerge.ts`
- `src/lib/cache.ts`
- `src/lib/httpCache.ts`
- small extracted helpers from `src/lib/finra-graph.ts`

**What unit tests should cover:**

- label and name normalization
- employment flattening and current/previous employment selection
- detail payload normalization
- firm/person node matching helpers
- location and UI text formatting
- cache key generation and expiration helpers
- merge precedence rules between FINRA and SEC payloads

**Examples of high-value unit cases:**

- current employment is preferred over previous employment when both appear
- empty or malformed upstream values normalize safely
- duplicate employment or disclosure records are deduplicated correctly
- SEC / FINRA IDs are formatted consistently for display and linking

---

### 2. Integration tests for API routes

Use integration tests for route handlers and local data/storage behavior.

**Recommended tool:** `Vitest` in Node environment

**Targets:**

- `src/app/api/finra/graph/route.ts`
- `src/app/api/finra/graph-search/route.ts`
- `src/app/api/finra/graph-reset/route.ts`
- `src/app/api/finra/individual/[crd]/route.ts`
- `src/app/api/finra/firm/[id]/route.ts`
- `src/app/api/finra/merged/**`
- `src/app/api/finra/seeds/route.ts`
- `src/app/api/finra/profile/[name]/route.ts`
- `src/app/api/finra/cache-stats/route.ts`
- `src/app/api/finra/health/route.ts`

**Integration-test style:**

- call route handlers directly where possible
- use local fixture payloads instead of hitting live FINRA / SEC services
- mock Redis and filesystem adapters at the boundary, not deep inside parsing logic
- keep one fixture set intentionally small and deterministic

**What route integration should validate:**

- correct status codes and error responses
- behavior when graph data is present vs empty
- graph subset generation when `limit` is used
- merged detail route output shape and fallback behavior
- seed/profile route persistence rules
- cache-stat aggregation behavior
- health route stability in minimal local environments

**Critical route scenarios:**

- missing CRD / firm ID returns expected error shape
- merged routes do not fail when only one upstream source is present
- graph reset really clears persisted graph state
- graph append does not corrupt existing store shape
- seeds/profile routes tolerate malformed or partial input safely

---

### 3. Integration tests for data and artifact scripts

Use script-level integration tests for the data pipeline that powers the app.

**Recommended tool:** `Vitest` in Node environment

**Targets:**

- `scripts/build_graph_from_cache.js`
- `scripts/build_primed_cache_bundle.js`
- `scripts/check_local_integrity.js`
- `scripts/recompute_graph_meta.js`
- `scripts/enrich_nodes.js`

**Fixture strategy:**

Create a very small, synthetic cache fixture set that covers:

- one individual with current employment
- one individual with previous employment
- one firm with direct owners / executive officers
- one entity-only control record
- one disclosure-bearing record
- one sparse or partially missing detail record

**What script integration should validate:**

- graph artifact files are created successfully
- nodes and links are generated with expected IDs and relationship types
- employment-scope options (`current`, `previous`, `all`, `none`) behave correctly
- primed-cache bundles include expected cache keys only
- recomputed meta counts match graph contents
- integrity checker reports expected pass/fail output for known fixture states

---

### 4. Browser end-to-end tests

Use browser tests for cross-layer flows where DOM, D3, browser storage, and user behavior meet.

**Recommended tool:** `Playwright`

Shared browser-test setup for this repo lives in `tests/e2e/helpers/finra-e2e.ts`.

Use that helper layer before duplicating:

- deterministic `localStorage` / `sessionStorage` seeding
- persisted session envelopes
- selection-log seed data
- graph/session reset setup for graph-dependent tests

**Primary UI surfaces to cover:**

- search / fetch flow
- sidebar open/close/pin behavior
- selection log behavior
- trace mode behavior
- trace-with-log behavior
- session persistence across reloads
- reset-session behavior
- empty-state onboarding behavior

**Core E2E scenarios:**

1. **Search and open detail**
   - enter query
   - fetch nodes
   - click a result node
   - verify sidebar renders correct content

2. **Selection log updates**
   - click multiple nodes
   - verify log entries appear in order
   - verify copy/clear actions work

3. **Trace Mode**
   - select or highlight nodes
   - enable trace mode
   - verify trace classes are applied to nodes/links
   - verify clear highlight does not incorrectly disable trace mode

4. **Trace with Log**
   - build a log via node clicks
   - enable log trace
   - verify the standalone or sidebar log surface remains usable
   - verify `trace-log` classes appear
   - verify log clear removes stale trace state

5. **Session persistence**
   - select node, add highlights, reload page
   - verify session state restores

6. **Reset Session**
   - create state
   - reset session
   - verify graph, sidebar, and trace state clear correctly

7. **Responsive smoke test**
   - mobile viewport
   - toggle hamburger menu
   - open info/log/legend controls
   - verify dismiss behavior and pin behavior still work

**Browser assertion preference:**

- assert CSS classes / aria states / visible text
- avoid pixel-perfect assertions unless testing a specific visual regression

**Repo-specific Playwright conventions:**

- prefer deterministic seeded state over relying on incidental initial graph nodes
- use visible controls such as `Toggle menu` and the sidebar `Log` toggle before clicking nested actions
- for trace coverage, assert verified runtime behavior such as `trace-log` classes on rendered graph nodes
- use app-visible readiness signals like `Displayed: ... Links` when waiting for graph-dependent flows

### Current implemented browser regressions

The current repo already includes focused Playwright coverage for:

- app shell smoke: `tests/e2e/smoke.spec.ts`
- mobile menu open/close behavior: `tests/e2e/mobile-menu.spec.ts`
- persisted `Trace with Log` UI state: `tests/e2e/trace-log.spec.ts`
- rendered graph-node trace classes: `tests/e2e/trace-highlight.spec.ts`
- selection-log clear persistence: `tests/e2e/selection-log-clear.spec.ts`
- reset-session persistence: `tests/e2e/reset-session.spec.ts`

These specs are intentionally scoped to deterministic class/state assertions rather than fragile visual snapshots.

---

### 5. Contract and fixture tests for upstream payload handling

The application depends on external FINRA / SEC payload shapes that can drift.

**Recommended approach:**

- store representative fixture samples from cached local payloads
- validate that the normalization layer still extracts expected fields from them
- keep a small set of “golden” payload fixtures for individuals and firms

**Should cover:**

- FINRA individual payloads
- SEC individual payloads
- FINRA firm payloads
- SEC firm payloads
- sparse / partially missing payloads
- payloads with disclosures and ownership sections

This layer protects the repo from upstream payload surprises without requiring live network calls in CI.

---

## Coverage map by application area

### Graph UI and interaction state

**Level:** unit + E2E

**Must cover:**

- selection state
- highlight root behavior
- trace endpoint resolution
- trace-with-log chronology
- sidebar info/log toggle behavior
- standalone selection-log fallback behavior
- localStorage session restore and clear

### Regulatory detail rendering

**Level:** unit + integration + E2E spot checks

**Must cover:**

- merged detail rendering
- disclosure extraction and ordering
- employment timeline ordering
- owner/control relationship display
- active/inactive badge logic

### API and storage

**Level:** integration

**Must cover:**

- graph fetch/search/reset/append
- merged detail routes
- seeds/profile routes
- cache stats and health routes
- behavior with and without Redis-backed state

### Artifact generation and maintenance scripts

**Level:** integration

**Must cover:**

- graph generation from local cached data
- primed cache bundle generation
- meta recomputation
- integrity checks

### Deployment confidence

**Level:** smoke tests

**Must cover:**

- production build succeeds
- runtime graph artifact exists
- health route responds
- one minimal Playwright smoke flow passes against a production-style build

---

## Proposed implementation phases

### Phase 1 — fast confidence wins

Add tests for the highest-risk logic first.

1. Unit tests for:
   - `detailUtils.ts`
   - `formatters.ts`
   - key merge helpers
2. Integration tests for:
   - `graph` route
   - `individual` merged detail route
   - `firm` merged detail route
   - `graph-reset` route
3. One Playwright flow for:
   - search → select nodes → trace with log

### Phase 2 — graph and storage hardening

1. Add more route integration coverage for:
   - seeds/profile
   - cache stats
   - graph-search
2. Add session persistence E2E coverage
3. Add fixture-based script tests for `build_graph_from_cache.js`

### Phase 3 — release confidence

1. Add mobile/responsive E2E smoke tests
2. Add script tests for bundle/meta/integrity flows
3. Add CI matrix for:
   - type-check
   - unit/integration tests
   - browser smoke tests

---

## Suggested future test structure

```text
src/
  lib/
    __tests__/
  app/api/finra/
    __tests__/

tests/
  fixtures/
    api/
    graph/
    cache/
  integration/
  e2e/
  helpers/
```

Suggested naming:

- `*.unit.test.ts` for pure logic
- `*.integration.test.ts` for route/script tests
- `*.spec.ts` for Playwright browser tests

---

## Suggested commands to add later

These are recommended next steps once the test stack is installed.

```bash
pnpm exec vitest run
pnpm exec vitest run --dir src/lib
pnpm exec vitest run --dir tests/integration
pnpm exec playwright test
pnpm exec playwright test tests/e2e/trace-log.spec.ts
```

If scripts are added to `package.json`, prefer:

```json
{
	"test": "vitest run",
	"test:unit": "vitest run --dir src/lib --dir src/app/api/finra",
	"test:integration": "vitest run --dir tests/integration",
	"test:e2e": "playwright test",
	"test:smoke": "playwright test tests/e2e/smoke.spec.ts"
}
```

---

## CI recommendation

A practical CI pipeline for this repo should run in this order:

1. `pnpm exec tsc --noEmit`
2. unit tests
3. integration tests
4. build: `pnpm build`
5. browser smoke tests against local production server

This order catches cheap failures early and saves browser time for code that already compiles and builds.

---

## Exit criteria for “main parts covered”

The app should be considered meaningfully covered once all of the following are true:

- core normalization helpers have unit coverage
- major FINRA API route families have integration coverage
- graph artifact build script has fixture-driven integration coverage
- at least one end-to-end flow covers search, selection, sidebar, log trace, and reset behavior
- session persistence has at least one automated browser test
- production build plus health smoke test runs in CI

---

## Immediate next recommendation

If implementation starts right away, the best first slice is:

1. install `vitest` and `@playwright/test`
2. add unit tests for `detailUtils.ts` and `formatters.ts`
3. add one Playwright regression for the `Trace with Log` flow
4. add one integration test for merged individual detail route

That sequence gives the highest confidence-per-effort for this codebase.
