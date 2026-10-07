---
name: log-forensics
description: 'Use for any bug — error in logs/stacktrace, wrong behaviour, flaky test: red loop first, then root cause.'
---

# Bug forensics

⚠️ **The live system stays read-only** — logs, code, DB (SELECT only); nothing restarted or edited
there, because that destroys the evidence. Your own reproduction harness is the exception and the point
of phase 3: a local test, script or tagged log is how the evidence gets _captured_, not erased.

## 1. Collect evidence

1. The symptom, exact: error text + timestamp — or, with no error, observed vs expected, one line
   each. Plus environment (stand/prod, build version/commit — a later build may already fix it).
2. Context around it: not the last line of the log but the **first error in the chain**. Read
   backwards in time to the moment everything was fine. A cascade of 30 errors usually has one root.
3. Neighbours: other services at that same moment (cross-service failure), a deploy, migration or
   restart nearby in time.

## 2. From symptom to code

1. Stacktrace → exact line, allowing for version skew: read the code of the **deployed** version
   (git by build hash). Minified frontend → sourcemaps, or locate by message text. No error at all →
   start at the entry point the symptom shows (route, handler, component).
2. From that line, walk the data flow backwards: which value led here, where it came from (request /
   DB / config).
3. **Working analog.** Find the nearest thing that works — the same feature on another entity, route
   or stand, the previous build, a sibling call site — and list **every** difference from the broken
   one, however small. "That can't matter" is an assumption to test.

## 3. Build the loop — the gate

This is the skill; everything after it is mechanical. With a **tight** pass/fail signal that goes red on
_this_ bug, bisection and instrumentation just consume it. Spend disproportionate effort here. Which
loop, the flaky and performance branches, no loop possible → [references/loops.md](references/loops.md).

**Gate — name one command you have ALREADY RUN** (paste the invocation and its output), and that is:

- **red-capable** — drives the real code path and asserts the _user's exact symptom_, so it can go red
  now and green once fixed. "Runs without erroring" is not this.
- **deterministic** — same verdict every run; a flaky bug is measured as a rate instead (loops.md).
- **fast** — seconds, and **agent-runnable** unattended.

Catching yourself reading code to build a theory before this command exists is the exact failure this
gate prevents.

**Minimise** once red: cut one element at a time, re-run after each, until every remaining one is
load-bearing — the cut order and why it pays: loops.md §Minimise.

## 4. Hypothesise, then instrument

1. Generate **3–5 ranked hypotheses before testing any of them** — single-hypothesis generation anchors
   on the first plausible idea. Each must be **falsifiable**: "if X is the cause, then changing Y makes
   it disappear". Cannot state the prediction → it is a vibe; sharpen or discard it.
2. Show the ranked list to the user and start probing #1 in the same turn — they re-rank instantly
   ("we deployed #3 yesterday") when they see it, and that redirects the next probe. Wait for them
   only when the top probe is costly or destructive (a stand restart, a data change).
3. Probe one variable at a time, each probe mapped to a specific prediction. Prefer a debugger/REPL
   breakpoint over ten logs; targeted logs at the boundaries that distinguish hypotheses.
4. **Tag every debug log with a unique prefix** — `[DEBUG-a4f2]` — so cleanup at the end is a single
   grep. Untagged instrumentation survives into the MR; tagged instrumentation dies.
5. A hypothesis is confirmed when the loop reproduces AND the cause explains every symptom, not some.

## 5. Fix, verdict & handover

- Diagnosis: cause → chain to the symptom → whose code (front / back / infra / data).
- Cause confirmed → grep its **shape** first: same function, same file, the parallel handler, every
  other caller. Each copy is fixed in the same change or named in the handover.
- Frontend → fix the root, one change per loop run (plus `agentdeck-kit:bug-regression-test`).
  Backend/infra → a report with evidence (log lines, file:line, repro) for that team; edits only on an
  explicit yes.
- **Three fixes that left the loop red → stop.** A fix that moves the symptom elsewhere points at
  structure (shared state, coupling, a wrong abstraction), not a missing line. Bring the user the
  evidence — each hypothesis, what its fix changed, what the loop showed — and question the
  architecture together before the next edit.
- Cleanup before declaring done: re-run the phase-3 loop against the original scenario, `grep` the
  `[DEBUG-` prefix to zero, delete throwaway harnesses. State which hypothesis proved correct in the
  fix's commit or MR body — that is what the next person debugging this learns from.
- **Then ask: what would have prevented this bug?** Answer it _after_ the fix, when you know most. If
  the answer is architectural — no seam to lock it down, tangled callers — hand the specifics to
  `agentdeck-kit:refactor-code-health`. Stand quirk → project memory. Recurring class of failure → `.agent/notes.md`.

## Red flags

Before declaring done, run the finished investigation against
[references/red-flags.md](references/red-flags.md) — every line answered, none skipped.
