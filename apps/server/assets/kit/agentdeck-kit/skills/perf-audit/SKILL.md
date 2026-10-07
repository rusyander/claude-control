---
name: perf-audit
description: 'Use on frontend speed complaints or a perf-audit request — measure first: bundle, network, renders, timings — then fixes.'
---

# Frontend performance audit

Rule #1: **measure first, fix second.**

## 1. Baseline — Gate before any fix

The complaint drives the audit: reproduce the user's sore spot on the stand and time it first;
not reproducible → report that and stop.

**Gate: `.agent/tmp/perf-baseline.md` exists BEFORE the first fix** — bundle top-10 from a named
analyzer, DCL/LCP per target page, the complaint interaction timed (median of ≥3 runs). Every §2
finding cites a number from it.

1. **Bundle**: build with a named analyzer — vite → `rollup-plugin-visualizer` (not
   `vite-bundle-visualizer`: last release 2024-05); webpack → `webpack-bundle-analyzer`; any bundler →
   `npx source-map-explorer 'dist/**/*.js'`. Record: top-10 heavy modules, duplicated libraries
   (two versions of one), what landed in the main chunk but should be lazy. Analyzer artifact
   (stats HTML/JSON) → `.agent/tmp/`.
2. **Network/load**: Playwright over the target pages — evaluate
   `performance.getEntriesByType('navigation')` plus LCP via `PerformanceObserver`, ≥3 runs,
   take the median: DCL, LCP, request count/size, what blocks the waterfall.
3. **Runtime**: the slow interaction from the complaint — `performance.now()` around the action,
   long tasks; ≥3 runs, median. React: excess re-renders (profiler / why-did-you-render,
   pointwise; with React Compiler manual memo is usually unnecessary).
4. **API**: separate slow backend responses from frontend problems (the waterfall shows it) —
   those are different tasks.

## 2. Diagnosis and plan

Findings cite baseline numbers: "X.js, 480 KB in the main chunk, used only on /reports" →
proposal → expected gain. Priority: (1) what the user actually feels per the complaint,
(2) cheap big wins (lazy routes, duplicate libraries, huge lists without virtualization,
uncompressed images), (3) micro-optimizations — last or never. Plan goes to the user for approval.

## 3. Fixes and control measurement

One fix → re-measure with the same pages, same script, same run count → before/after columns in
the same baseline file. No help → roll it back, don't leave it "just in case". Behaviour must not
change; lazy loading → check the loading UX states.

## Red flags — run against the finished audit

- Optimizing with no baseline artifact, or no control measurement afterwards.
- A single noisy run taken as the baseline instead of a median of ≥3.
- memo/useCallback carpet-bombing without profiling (with React Compiler, doubly so).
- The mirror image: memo/useCallback removed as "unnecessary" while its value sits in an effect's
  dependency array — the effect now re-fires every render. A behaviour change, not a cleanup.
- "Optimized" something nobody complained about instead of the user's sore spot.
- Frontend fixes and complaints about a slow API mixed into one pile.
