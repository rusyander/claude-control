# Loops — which one to build, and the hard branches

Reached from SKILL.md §3. The gate there is the bar; this file is how to reach it.

## Catalogue, roughly in order

1. A failing test at whatever seam reaches the bug.
2. A curl/HTTP script against the running stand.
3. A CLI invocation diffed against known-good output.
4. A Playwright script driving the UI, asserting on DOM / console / network.
5. A captured payload or HAR replayed through the code path in isolation.
6. A throwaway harness calling the bug path directly.
7. A property/fuzz loop for "sometimes wrong".
8. A bisection harness when it appeared between a known-good and a known-bad state (`git bisect run <loop>`).

Earlier rungs run faster and survive as the regression test; climb only when the rung below cannot
reach the symptom.

## Minimise

Once the loop is red, shrink to the smallest scenario that still goes red — cut inputs, callers,
config and steps **one at a time**, re-running after each cut. Done when every remaining element is
load-bearing: removing any one turns it green. This shrinks the hypothesis space, and the minimal
scenario becomes the clean regression test.

## Flaky / non-deterministic

The goal is a higher reproduction rate, not a clean repro: loop the trigger 100× (a shell loop,
Playwright `--repeat-each`), add stress (CPU throttling, parallel workers), narrow timing windows.
50% is debuggable, 1% is not. Record the rate — `k/N red` — before the fix; the fix is proven by 0/N
at the same N, never by one green run.

Usual roots, checked in this order:

- **Order dependence** — green alone, red in the full file: state leaks between tests (module-level
  cache, a mock not restored, a shared DB row). Run the single test alone, then the file.
- **Arbitrary waits** — a `sleep`/timeout guessing how long something takes. Wait on the condition
  itself (the element, the response, the event); a timeout is only the ceiling.
- **Unawaited async** — a promise nobody awaits finishes after the assertion.
- **Time and locale** — the clock, a timezone, a date boundary; freeze the clock at the boundary.
- **Randomness** — an unseeded generator, unordered iteration over a set/map, parallel result order.

## Performance regression

Logs are the wrong instrument. Establish a baseline measurement (timing harness, profiler, query
plan), then bisect between the fast and the slow state. Measure first, fix second; the numbers-first
method in full is skill `agentdeck-kit:perf-audit`.

## No loop possible

Say so explicitly, list what was tried, and ask for one of: access to the environment that reproduces
it, a captured artifact (HAR, log dump, screen recording with timestamps), or permission for
temporary instrumentation. A theory built without a loop is labelled a theory in the report.
