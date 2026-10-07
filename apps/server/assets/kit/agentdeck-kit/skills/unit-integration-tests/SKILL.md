---
name: unit-integration-tests
description: 'Use when writing unit/integration tests; precedent, plan, each test proven by a killed mutant. E2E → playwright-e2e-tests.'
---

# Unit / integration tests

A test is worth the mutant it kills. Green proves the suite runs; a test that stays green while the
behaviour it names is broken is decoration. The twelve shapes that shipped green in real MRs, and the
mutant exposing each: [references/weak-tests.md](references/weak-tests.md) — `#N` below points there.

## 1. Analyze (before writing)

1. **Stack and precedent** — from configs and existing tests, never memory: runner, placement, naming,
   helpers, fixtures, how the boundary is faked (msw, sqlmock, httptest). Reuse them; one infrastructure.
2. **Candidates by value**: branching business logic and utils (unit); recent bug sites (git log,
   project memory); hooks/components/store slices/API↔UI mappings (integration); a critical path with
   no test. Getters, logic-free markup and behaviour-free wrappers stay out.
3. **Plan for approval** — rows `place → level → scenario → the mutant it must kill` (one line of
   production code breaking exactly that scenario, weak-tests §Picking). A scenario with no nameable
   mutant has no behaviour — drop it. Bulk writing starts after the user's yes.

## 2. Write

- **Behaviour through the public contract** — input→output, what the user sees (`getByRole/getByText`),
  the request that leaves. A behaviour-preserving refactor keeps the test green.
- **Run the real path to the boundary.** Substitute only network, clock, filesystem, randomness, a paid
  API — the highest seam the code already has, one per test. The layer holding the behaviour runs for
  real (#2); the fake takes the branch production takes, the error in the shape it arrives (#3). A
  seam added _for_ the test is a design change — propose it.
- **Assert the effect at the boundary** — the URL/body msw captured, the SQL args sqlmock saw; a mock's
  call count alone proves the call, not the effect (#7).
- **Each side of every branch** the scenario touches (#6), and the value OUTSIDE the domain: -10 and 150
  for a percent, a string where a number goes, the missing field. Assert the refusal (error, clamp,
  status); code that silently accepts it is a product finding to report — the test keeps demanding the
  refusal (fixture run 18.09.2026: `pct=-10` turned a discount into a surcharge).
- **One accepted form per assertion** (#5); **expected values from an independent source** — a literal,
  a worked example, the spec (#12).
- **Isolation and determinism**: state captured per test and reset (#8); fake timers, seeded
  randomness; output free of locale/ICU/OS coupling — normalize whitespace or pin the platform (#9).
- **AAA, one scenario per test, the name reads as the claim**; table-driven where idiomatic (Go always;
  `each` for same-shaped cases); snapshots only for stable serializations.
- **Vertical slices**: one test → its code → the next, each a **tracer bullet** shaped by what the last
  cycle taught. Every test written first verifies imagined behaviour.

## 3. Prove each test can go red

Gate: `node <kit>/tools/mustfail.mjs --cmd "<narrowed test command>" --mutants .agent/tmp/mutants.json`
— the plan's mutants, each with `test` = the scenario's test name as the runner prints it. Exit 0:
every mutant `RED` on its named test, the identity control survived. `GREEN` → strengthen the test or
drop it · `RED·wrong` → another test caught it, this one is blind · `RED·build` → pick a behavioural
mutant. Tests written with a bug fix prove themselves on the pre-fix tree instead → `agentdeck-kit:bug-regression-test`.

## 4. Run and report

1. Gate: the project's test command exits 0 — quote `N new / M total / K skipped`. A skip over a planned
   scenario is a failure (#4); pre-existing red is reported apart, never absorbed.
2. A test red on a real bug: report it; the code is fixed only with consent, the test stays as written.
3. Behaviour changed on purpose → grep sibling suites (`QA/`, `e2e/`, contract tests) for the old
   expectation (#10).
4. Report: place → scenario → mutant killed; what is deliberately uncovered and why.

## Red flags — run against the finished suite

- A test in the report with no killed mutant beside it.
- Assert-free or trivial tests written for the coverage number.
- A fake at the layer under test; a mock's call count as the only assertion.
- A test green because it copied the actual (broken) behaviour.
- All tests written before any implementation; the project's precedents and helpers ignored.
