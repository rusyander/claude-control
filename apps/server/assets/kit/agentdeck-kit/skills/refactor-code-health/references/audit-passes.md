# Phase 1 audit — 4 passes in detail

Passes can run as parallel subagents.

## 1a. Dead code

- Use project tooling if present (knip / ts-prune / depcheck, `go vet`+unused, vulture...); otherwise targeted search: exports with no imports, files outside the import graph, unreachable branches.
- Go/Python tools absent locally → run them pinned without installing: `go run honnef.co/go/tools/cmd/staticcheck@<ver> -checks U1000 ./...`, `go run golang.org/x/tools/cmd/deadcode@<ver> -test ./...`, `uvx vulture <pkg>` / `uvx ruff check <files>`. Not runnable → say so in the report, never imply the pass ran. Dead generated code (sqlc, mocks, protobuf) is removed at its input — the query, the interface, the `.proto` — never in the output.
- Also: commented-out code, finished feature flags, unused deps in the manifest, i18n keys / assets / styles with no references, deprecated wrappers.
- WARNING: "unused" != safe to delete — check DYNAMIC usages: string keys (grep by name), reflection/DI, routes, a library's public API, configs, calls from scripts.
- Done when every tool finding is triaged: in the findings table, or named a false positive with the dynamic usage that saves it.

## 1b. Duplicates

- Copy-paste (jscpd if available; else scan suspiciously similar files/functions); semantic dupes: two components/utils doing the same thing differently.
- Collapse into a single source **following dependency direction** (shared code moves down into the project's shared layer per its convention), not via cross-imports.
- Rule of three: duplication in 2 places is a candidate, not a verdict; the abstraction must be simpler than the sum of the dupes.
- Done when every churn hot-spot from Phase 0.4 has been visited; skips named.

## 1c. Simplification

- Wrappers/pass-through layers with no logic (just proxy props/children) — delete (update usages).
- Deep nesting → guard clauses / early return; long functions → decompose **per the project's thresholds** (a signal, not a command).
- Over-parameterization "for the future" (YAGNI), unreachable checks, overcomplicated types, state where a derived value suffices.
- Cascade tails: removed a usage → also remove orphaned imports/props/types/styles.
- Done when every churn hot-spot from Phase 0.4 has been visited; skips named.

## 1d. Modularity & portability

Judge with these terms — each is a compact handle for a question worth asking:

- **Depth** — how much behaviour sits behind how small an interface. Deep is good; a module whose
  interface is nearly as large as its body costs more to learn than it saves.
- **Interface** — everything a caller must hold in mind: signature, types, ordering, side effects. It is
  also the **test surface** — a rule reachable only through internals means the interface is wrong, or
  the test is aimed at the wrong level.
- **Seam** — a point where behaviour can be swapped without editing the code around it. Seams are where
  tests and future variants attach; every extra one is interface you now owe.
- **Adapter** — code translating one interface into another. One adapter is a _hypothetical_ seam; the
  second independent one makes it real. Build the abstraction at the second, not the first.
- **Leverage** — how much a change buys. Prefer edits that make a whole class of later edits cheaper.
- **Locality** — how much of the codebase a reader must load to understand one file. Locality is what
  makes "lift and move" possible at all.
- **Deletion test** — delete the module mentally: does the breakage cluster at one boundary (a real
  module) or spray across the tree (a leaky one)? Nothing breaks → it earns nothing and can go.

- Layer boundaries per the project's architecture (profile): forbidden cross-imports, reaching into another module's internals past its public API/barrel.
- Portability test (user's criterion): a module can be "lifted and moved" — dependencies explicit (params/props, not global reach-ins), utils pure, domain code separated from generic.
- Hidden coupling: shared mutable state, side effects in imports, import cycles.
