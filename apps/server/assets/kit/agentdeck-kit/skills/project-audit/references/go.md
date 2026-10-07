# Go canon — audit playbook

Judge Go by Go idiom: std-lib first, composition, explicit errors. Structures imported from
Java/C# — DI containers, interface-per-struct, getter/setter shells, inheritance simulation — are
findings HERE even where another language would call them best practice.

## A. Package & project layout

- Package names: short, lower, domain-meaningful; `util`/`common`/`helpers`/`base` = P2 (a name that
  says nothing collects everything).
- `internal/` guards non-public code; `cmd/<app>/main.go` thin — wiring only.
- No circular escape hatches (interfaces created solely to break an import cycle the layout caused).
- `init()` rare and side-effect-light; package-level mutable state = P2.

## B. Interfaces & composition

- Interfaces defined at the CONSUMER, small (1-3 methods); accept interfaces, return concrete types.
- Preemptive interfaces with a single implementation "for mockability" = P2 (Java habit).
- No DI framework / service locator — dependencies wired explicitly in `main`; embedding for
  composition, never to simulate inheritance hierarchies.
- Getters/setters wrapping plain fields = P3 (export the field or rethink ownership).

## C. Errors

- Every error handled or explicitly ignored (`_ =` with a reason); `errors.Is/As` + `%w` wrapping
  with context at each layer; message strings lower-case, no "failed to" stutter chains.
- Sentinel errors / typed errors where callers branch; string-matching on `err.Error()` = P1.
- `panic` only for programmer errors at init; recover only at goroutine/handler boundaries.

## D. Concurrency

- Every goroutine has a known exit path; fire-and-forget `go func(){}` without lifecycle = P1
  (leak). `errgroup`/`sync.WaitGroup` for fan-out; worker pools bounded.
- `context.Context` first parameter through every blocking/IO path; stored in a struct = P2.
- Channel direction annotated in signatures; select with `ctx.Done()` in loops; data races: `go test
-race` clean is the gate.
- Shared state: choose mutex or channel deliberately; both on the same state = P2 confusion.

## E. API & data boundaries

- HTTP handlers thin: decode → validate → call domain → encode; business logic out of handlers.
- Struct tags correct and tested (`json`, `db`); zero values meaningful or pointers deliberate.
- Timeouts on every outbound client (`http.Client{Timeout}`), server read/write timeouts set = P1
  when absent in a service.

## F. Tooling & tests

- `gofmt`/`goimports` clean by definition; `go vet ./...` clean; `golangci-lint` config present in
  a serious service (absence = P3).
- Table-driven tests with subtests (`t.Run`); `t.Helper()` in helpers; parallel where independent.
- Benchmarks/pprof hooks for hot paths claimed as such.
