---
name: bug-regression-test
description: 'Use after fixing a non-trivial bug — on approval, add a regression test: fails before the fix, passes after.'
---

# Regression test after a fix

Every substantive bug fixed leaves a test that turns RED the day the bug returns — proved on the
pre-fix tree, by command. Weak shapes (`#N`): `unit-integration-tests/references/weak-tests.md`.

## 1. Does this bug deserve a test

Yes: logic error, edge case, contract drift, race, regression of old behaviour.
No: text typo, a purely visual shift (that is screenshots), a one-off script.
Unsure → propose it; the user decides.

## 2. The level that runs the defect

The cheapest level that EXECUTES the file holding the defect: pure function → unit; hook/component →
integration (RTL); handler/store → through the real router / on sqlmock; front↔back seam → contract
check / msw; reproducible only as a full flow → e2e, the last resort. A cheaper level that skips the
defect's layer is green on both trees (#2). Stack and precedent: `agentdeck-kit:unit-integration-tests`.

## 3. The test reproduces the BUG

1. Scenario = the reproduction: same entry point, data and conditions. A reviewer's, QA's or user's
   repro outranks mine — the test goes through THEIR entry point.
2. Assert the corrected **behaviour** — what the user sees, what the function returns — never the
   fix's implementation details.
3. Name it after the bug: "model on send comes from the selector, not the chat cache".

## 4. Prove it catches — red-before, green-after

Gate: `node <kit>/tools/mustfail.mjs --base HEAD --files <fixed files> --cmd "<narrowed test command>"`
(fix uncommitted; committed on a branch → the default base). Exit 0 = every fixed file RED when put
back to base, then restored byte-exact — the tool is the only revert this skill uses.

- `GREEN` → the test does not see the defect: a forward guard at best, never the regression test.
  Rewrite it.
- `RED·symbol` → the test imports what the fix added, so the old tree fails on import (#11). Rewrite it
  against the pre-existing API, or prove it with `--mutants`: the fix's logic line put back to its old
  form, new symbols kept, `test` = this test's name.
- Fix unrevertable (env-dependent) → argue the red run in prose AND state the gate was not run.

## 5. Run & record

Gate: the project's test command for the touched package green, output quoted in the report.
Behaviour changed on purpose → grep sibling suites for the old expectation (#10).
One line into the report / `TASKS.md`: `regression test: <path> · mustfail RED`.
No test infrastructure and setting it up now is inappropriate → say so honestly and offer the
alternative: a check script in `.agent/tmp` plus a line in `notes.md`.

## Red flags — run against the finished test

- No `mustfail` verdict in the report.
- The test drives a layer the defect does not live in.
- RED counted from an import failure.
- e2e where a unit test runs the same defect.
- A stub written to tick the `agentdeck-kit:prepare-mr` checklist.
