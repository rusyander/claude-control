---
name: playwright-e2e-tests
description: 'Use when asked to write Playwright e2e tests — analyze kit/auth/flows, plan for approval, tests to green. Unit/integration → unit-integration-tests.'
---

# Playwright e2e tests

Flake mechanics below are calibrated on a real QA suite (80 files) — each one
cost a red nightly run before its comment was written.

## 1. Analyze (before writing)

1. **Existing infrastructure**: `playwright.config.*`, the e2e folder, a hand-rolled kit (login/launch/
   screenshots, e.g. `e2e/lib.mjs`), `.env` URLs/creds, saved `storageState`, setup/teardown projects.
   Present → reuse and follow it; absent → propose `npm init playwright` + config (baseURL,
   trace/screenshot on failure, projects).
2. **Critical flows** from routing, README, project memory, bug history: auth (+ the negative case),
   the main CRUD journeys, money paths, recently fixed scenarios. Logic belongs to unit tests; e2e
   covers end-to-end journeys.
3. **Stand constraints**: login brute-force protection (log in once, never hammer failures), paid calls
   (LLM), shared data that other people and runs also write — pagination, occupied slots, foreign rows.
4. **Plan for approval**: `flow → steps → assertions → what makes each assertion go red`, plus what is
   deliberately uncovered. Writing starts after the yes.

## 2. Writing

- **Locators by role and name**: `getByRole/getByLabel/getByPlaceholder/getByText`; `data-testid` only
  where semantics are absent and the project uses it. Overlays by name — `getByRole('dialog', { name })`
  or `.filter({ hasText })`: a closing dialog stays in the DOM through its exit animation, and a bare
  `getByRole('dialog')` grabs it (`cp/instances/tokens.spec.ts`).
- **Web-first assertions**: `await expect(locator).toBeVisible()/toHaveText()` — timing comes from the UI
  state; `waitForTimeout` only as a diagnostic crutch.
- **Act on settled targets**: a dialog/menu finishes entering before a click inside it — a click during
  the entry animation is reported done and does nothing.
- **Narrow before asserting presence or absence**: search/filter by the test's unique name first. On a
  shared stand the fresh row lands past page 1 — "row present" flakes, "row absent" passes vacuously
  (`inst/hooks/hooks.spec.ts`).
- **Every absence has a twin**: `toHaveCount(0)` / `toBeHidden()` follows a step where the same locator
  matched, so it is proven able to find the thing.
- **Force rare states**: empty list, error, slow response → `page.route(...).fulfill/abort`; a transient
  state awaited by luck is a flake (`cp/guardrails/audit.spec.ts`).
- **Isolation**: each test owns its data (prefix + timestamp), created via API/fixtures, independent of
  order. Log in once: setup project + `storageState`. Cleanup: a `teardown` project on the setup
  project, `retries: 0` — it runs after every dependent project, `--grep` included.
- **Retries leave a trace**: a retrying helper re-checks state first (a second click closes an opened
  menu) and records `test.info().annotations.push({ type: 'flaky-retry', … })`. `toPass` heals the
  test, not the defect — its ticket marker stays in the comment.
- **Assert the result the user sees** (toast, row, redirect) and, where critical, the response
  (`page.waitForResponse`) — a changed URL proves navigation, not the outcome.
- Fixtures (`test.extend`) for repeated scaffolding; Page Objects only where the project has them.
  Negative scenarios: validation errors, empty states, API failure.

## 3. Run and report

1. Gate: `npx playwright test <files> --repeat-each=2 --retries=0` (or the project's script with those
   flags) → exit 0, `0 flaky`, skipped count quoted — with retries on, a flake reads as passed. A flaky
   test is a test bug: fix the wait or the locator.
2. Prove the assertions can fail: a regression flow runs RED against the unfixed build where reachable,
   else against the old response replayed via `page.route`; at minimum flip one expected value per new
   test and watch it fail — reported as "the assertion executes", weaker than "catches the defect".
3. A real bug found → report it; the test stays as written. Suite red from the stand/env (down, 403/no
   token, lockout) → `agentdeck-kit:stand-doctor`, or report the env cause.
4. Report: flows covered, deliberately uncovered, the run command, leftover test data.

## Red flags — run against the finished suite

- A new assertion never seen red.
- An absence assertion with no matching twin; a list asserted before narrowing.
- Fixed delays, UI login per test, layout-class or `nth()` selectors.
- A retry without a trace; a flake closed by `toPass` with the defect marker dropped.
- 30 tests written without an agreed flow list.
