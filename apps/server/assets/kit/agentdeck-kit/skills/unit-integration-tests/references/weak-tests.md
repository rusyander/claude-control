# Weak tests — green, and proving nothing

Calibrated on 35 review reports of one real product (`.agent/reviews/`) + its suites. Every shape below
shipped green in a real MR; each names the mutant that exposes it. Shared by `agentdeck-kit:bug-regression-test`,
`agentdeck-kit:playwright-e2e-tests`, `agentdeck-kit:storybook-stories`.

## The shapes

| #   | Shape                                   | Case                                                                                                                                                                                          | Exposed by                                                   |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Green on the pre-fix tree               | !695 race test under `-race` passes on base: writers replace the field whole, so no race; the defect (reader returns the internal slice) only a copy check sees                               | `mustfail --base` on the fixed file                          |
| 2   | The layer holding the fix never runs    | !696 service test over a fake store; the fix lived in store + handler — reverting either stays green                                                                                          | `mustfail` per fixed file: every one RED                     |
| 3   | The production branch substituted away  | !694 every Redis counter built on unreachable `127.0.0.1:1`, the `MGet`/`Exec` path never runs; !713 monkeypatch drops `os.unshare` (macOS branch) while prod raises `OSError` EPERM          | mutant in the prod branch (`parseCount` off by one) survives |
| 4   | A skip reads as a pass                  | !713 env-gated skip turns the whole network dimension green; !606 F-134 fixture skips the entire PII layer when a shared slot is taken                                                        | the skipped count in the run output                          |
| 5   | Assertion accepts two forms             | !606 F-137 `rule_id == id or details.collection_id == id` pins neither                                                                                                                        | switch the code to the other form: survives                  |
| 6   | One side of a condition                 | !678 only the input side tested; `direction == "output"` made unconditional stays green                                                                                                       | condition → `true` / `false`                                 |
| 7   | The effect never reaches the boundary   | PROJ-207 F-10: 12 tests on type/search/page, none shows `owner` reaching the request                                                                                                          | drop the param from the request builder                      |
| 8   | State shared across tests               | PROJ-207 F-19 module-level `requests: string[]` never cleared — a test passes on the previous test's URL                                                                                      | delete this scenario's request: still green                  |
| 9   | Expectation coupled to the environment  | !606 F-43 `os.Chmod` read-only dir is a no-op on Windows; PROJ-913 `toLocaleString` NBSP vs space moves with the Node/ICU patch (RTL's normalizer hides it in DOM tests, not in string tests) | run on the other OS / Node patch                             |
| 10  | Old behaviour pinned in a sibling suite | !696 QA smoke `test_008` expects `{}`, red after merge                                                                                                                                        | grep `QA/`, `e2e/`, contract tests for the old value         |
| 11  | Red from a missing symbol               | !689/!690 tests do not compile on base (new fields) — red proves the field, a probe had to prove the behaviour                                                                                | `mustfail` prints `RED·symbol`                               |
| 12  | Tautology                               | expectation recomputed the way the code computes it                                                                                                                                           | literal from the spec: mutant in the formula survives        |

House baseline, that product's frontend: 1224 test files, 3 with `vi.mock`, 349 with msw — mocking at the
network boundary is already the norm; the live weak shapes there are #7 and #8, not module mocks.

## Picking the mutant

One line of production code, breaking exactly the behaviour the scenario claims — never a crash, never
a syntax error (that is `RED·build`, not a kill):

- comparison / boundary: `>=` → `>`, `< 0` → `<= 0`, `limit` → `limit + 1`
- condition: `if (x)` → `if (true)` / `if (false)`; `a && b` → `a`
- dropped field or param: delete the key from the object / query / request body
- error path: `return ErrNotFound` → `return nil`; `throw e` → `return fallback`
- constant result: `return compute(x)` → `return <a plausible literal>`
- skipped effect: `save(x);` → `` (`"replace": ""`)
- alias vs copy: `return slices.Clone(s.items)` → `return s.items`

## The run

Plan `.agent/tmp/mutants.json` — `[{"file","find","replace","test","nth"?}]`, `find` unique in the
file (else `nth`), `test` = the scenario's test name as the runner prints it:

```
node <kit>/tools/mustfail.mjs --cmd "<narrowed test command>" --mutants .agent/tmp/mutants.json
```

Baseline must be green; the identity control (the first `find` written back unchanged) runs by itself
and must SURVIVE. Verdicts: `RED` + the named test = killed · `GREEN` = survived, the test is
decoration · `RED·wrong` = another test caught it, this one did not · `RED·build` = build/import/
zero-tests red, not a kill · `RED·timeout` = hang, noticed. Exit 0 only when every mutant is killed by
its named test. Narrowed commands: `npx vitest run <test file>`, `go test ./<pkg>/ -run <Name>`,
`pytest <file>::<test>`.
