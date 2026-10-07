# Phases 2–3 — findings table, approval, application

## Phase 2. Findings & approval

Prioritized table: finding → where → proposed action → risk/gain.
Groups: "safe now" (dead code, cascade tails) / "local refactor" (dupes, simplification) / "structural" (module boundaries — separate pass later).
Ask the user via interactive choice which groups to apply. No approval → deliver the audit only, change nothing.

## Phase 3. Apply — small steps

0. **Prove the net ASSERTS, not just runs.** Green proves «unchanged» only for behaviour a test
   asserts: a test that calls the code and checks nothing goes red on a throw and green on a changed
   result (run 23.09: `_ = F(2)` — panic RED, `x*2 → x+2` GREEN). Many files → one coverage run first
   (`go test -cover`, `vitest --coverage`, `pytest --cov`) drops never-executed files at once. Then per
   function you will restructure, one mutant of its observable result (wrong-but-typed return, dropped
   field, inverted branch): `node <kit>/tools/mustfail.mjs --cmd "<narrowed test>" --mutants
.agent/tmp/mutants.json` — it writes, runs, restores byte-exact and runs the identity control itself.
   Only `RED` with the named test is a net; `GREEN`, `RED·build` (compile error, «no tests») = NO NET.
   No net → a characterization test first (odd outputs included — they are the behaviour), or the file
   keeps to «safe now». Plain `mustfail` (revert to base) does not apply: a reverted refactor is supposed
   to stay green.
1. One logical step → verification (type-check/lint/tests) → next. Don't mix steps; rollback must stay cheap.
   A step touching a handler, serializer or query: a golden before/after from the package's own
   handler test (httptest / TestClient), volatile fields (ids, timestamps) normalized; a sqlc
   `*.sql.go` diff empty for a pure refactor. Frontend: the touched package's public `.d.ts`
   (`tsc --emitDeclarationOnly`) identical before/after, rendered output through the existing tests or
   stories. A difference is the finding. Backend gate floor:
   `<kit>/skills/deep-review/references/backend.md` §The gate.
2. **No behavior changes** along the way: found a bug — report it separately, don't silently fix it inside the refactor.
3. Don't break public APIs (library exports, endpoints) without explicit approval; moves come with all usages updated in the same step, no deprecated shims (if the profile says so).
4. At the end: full project verification + brief style self-review of the new edits (style-conformance-review), final summary: deleted/collapsed/simplified (numbers: files, lines), plus what was deliberately NOT touched and why.

## Red flags — run against the finished refactor

- Big-bang: 50 files in one pass with no intermediate verification.
- Refactoring for its own sake: "prettier" but not simpler/more readable/more portable.
- Deleting "unused" code found only by static analysis, without checking dynamic usages.
- Generic best practice over a project idiom (the profile wins).
- Mixing refactor with behavior change / bug fix.
- «Tests green» quoted for a file no test executes (step 0 skipped).
- Backend code edited on the strength of the audit approval alone (the edit yes is separate).
- An abstraction more complex than the dupes it replaced.
