---
name: Playwright E2E Testing Patterns
description: "Use when adding or editing Playwright specs, E2E helpers, README/strategy docs that describe browser tests, or prompts that reference this repo's browser-testing conventions. Covers deterministic setup, visible-control preference, and graph trace assertions."
applyTo:
  - 'tests/e2e/**'
  - 'README.md'
  - 'TESTING_STRATEGY.md'
  - '.github/copilot-instructions.md'
---

# Playwright E2E testing patterns

This instruction supplements `.github/copilot-instructions.md` for browser tests in this repo.

## Prefer deterministic seeded state over opportunistic startup data

When a regression is about persisted UI state, browser storage, or session restore:

- seed `localStorage` / `sessionStorage` directly in the test
- use deterministic IDs and labels
- avoid depending on whatever nodes happen to render on first load

Good examples in this repo:

- persisted `finra_selection_log` entries for `Trace with Log`
- persisted `finra_session` envelopes for `Reset Session`
- helper-based state setup in `tests/e2e/helpers/finra-e2e.ts`

Avoid tests that require homepage graph contents to be non-empty unless the feature under test is specifically about graph bootstrap.

## Drive the real visible UI path when a control is transient or hidden

If a control lives inside the mobile menu or a sidebar view:

- open that surface first using the visible toggle the user would use
- assert visibility right before clicking the target control
- do not rely on clicking hidden elements through raw DOM evaluation unless the bug itself is about that hidden surface

Examples:

- open `Toggle menu` before clicking `Reset Session`
- open the sidebar `Log` toggle before asserting against `#fg-sidebar-selection-log-list`

## Assert classes, ARIA state, and stable text before visual styling

For this repo, Playwright regressions should prefer:

- `aria-pressed`, `aria-expanded`
- visible text such as `Log Trace On`
- stable class assertions such as `trace-log`, `hidden`, `trace-log-connector`
- app status text such as `Displayed: ... Links` when waiting for graph readiness

Avoid pixel-perfect or screenshot-style assertions unless the task is explicitly a visual-regression task.

## Keep graph-trace assertions scoped to verified runtime behavior

For graph tracing:

- it is valid to assert traced graph nodes receive `trace-log` classes
- only assert traced links when the runtime behavior is verified and deterministic for the selected scenario
- when testing trace readiness, prefer app-visible status or rendered-node signals over assumptions about transient loading states

## Reuse shared E2E helpers

Before duplicating storage setup or graph reset logic, check `tests/e2e/helpers/`.

Current helper responsibilities include:

- deterministic selection-log seeding
- persisted session seeding
- stored-session / stored-log reads
- browser graph reset before graph-dependent tests

If a new helper is added, keep it small and specific to repeated setup or inspection patterns.

## Update docs when the E2E contract changes

When browser-test conventions or the supported regression suite changes, update:

- `README.md`
- `TESTING_STRATEGY.md`
- any relevant instruction files under `.github/instructions/`

The docs should describe the current working tests, not an aspirational future suite.
