# Backend floor — Go / Python

The project's canon comes first: its rules are what the team agreed on, this is what no team argued
against. Most canons state principles («handle errors», «use timeouts»); this file is the concrete
shapes those principles miss in a diff. A canon rule that contradicts a line here wins — note it once
in the profile journal and stop raising it. SQL, migrations, API contract, Helm/K8s:
[data-deploy.md](data-deploy.md).

## Mechanical sweep — added lines, with `file:line`

One run per language before any file is opened; each hit is a candidate, proven or struck.

```bash
# added lines as file:line: text — pathspec per language: '*.go' · '*.py' · '*.sql' '*.go' '*.py' (SQL)
git diff -U0 <base>...HEAD -- '*.go' | awk '/^\+\+\+ /{f=substr($2,3);next} /^@@/{split($3,a,/[+,]/);n=a[2];next} /^\+/{print f":"n": "substr($0,2);n++}' | grep -E '<pattern>'
```

```text
Go   , _ :?= |^[^:]+:[0-9]+: \s*_ =             error discarded — on purpose? (`range` hits are noise)
Go   context\.(Background|TODO)\(\)              on a request path: cancellation and deadline cut off
Go   http\.Client\{|http\.(Get|Post)\(           no Timeout = a goroutine held forever (a STREAM wants the opposite, below)
Go   go func|wg\.Go                              what stops it (ctx, done, errgroup)? who sees its error?
Go   err\.Error\(\) ==|strings\.Contains\(err     error matched by text; errors.Is / errors.As
Go   time\.LoadLocation|os\.Getenv|os\.ReadFile  the assumed environment (axis-1 §Six miss classes)
Go   : \s*defer                                  inside a for? runs at function exit — fds, locks pile up
Go   recover\(\)                                 re-panics http.ErrAbortHandler? else a cut stream becomes a false 500
Go   Director:|\.Director =                       ReverseProxy: Connection-named headers stripped after it → Rewrite
Go   math/rand                                   near a token or secret — predictable 🔴🔵
Py   except:|except Exception:\s*$|: \s*pass$    swallowed failure; in async def a swallowed CancelledError breaks timeouts
Py   requests\.(get|post|put|patch|delete|request)\(   no timeout= → no timeout at all (httpx: 5 s default)
Py   time\.sleep|requests\.                      inside async def? blocks the event loop
Py   create_task\(|ensure_future\(               result unassigned → weak ref, collected mid-run (RUF006)
Py   AsyncClient\(|stream=True                   client per call or stream never aclose()d → pool exhausted
Py   def \w+\(.*=\s*(\[\]|\{\}|set\(\))          mutable default shared across calls
Py   datetime\.(now|utcnow)\(\)                  naive time; compare and store tz-aware
```

Removed lines (`^-`, same awk with `-`): `defer .*Close`, `Rollback`, `rows\.Err`, `ctx context\.Context`,
a validation call, a `LIMIT`. Analyzers vet skips, on added lines only: `go run
golang.org/x/tools/go/analysis/passes/nilness/cmd/nilness@latest ./pkg/...`, `staticcheck -checks
'SA*'`; `ruff check --isolated --no-cache --select ASYNC,BLE001,S,B,RUF006,FAST <changed .py>`.

## Go — what the sweep cannot see

- **Resources:** `rows.Close()` deferred AND `rows.Err()` checked after the loop (pgx: `CollectRows`)
  — a loop ended by a network error otherwise returns a silently truncated list. `defer
resp.Body.Close()` right after the `err` check.
- **Transactions:** `defer tx.Rollback()` right after `Begin`; the `Commit` error checked; no external
  call inside an open transaction — it holds the locks for the call's latency.
- **Nil traps:** a write to a nil map panics; a typed nil pointer returned as `error` is non-nil; an
  optional JSON field decoded into a value type loses «absent» vs «zero»; an `iota` enum whose zero is
  a real state turns an absent field into that state.
- **JSON contract:** `omitempty` on `bool`/`int` hides a legitimate `false`/`0`; a renamed tag breaks
  the API.
- **Concurrency:** shared map or slice without a lock — `go test -race`, not a reading. An early return
  strands senders: prove the leak with `goleak.VerifyNone` or the 1.27 `goroutineleak` profile.
- **Handlers:** `return` after writing the error; body bounded (`http.MaxBytesReader`) before decode;
  auth and validation decided before the first byte — after it the status is frozen at 200 and an
  error has to go in-band (`event: error`).
- **Streams (SSE, proxying):** `Server.WriteTimeout` is an absolute deadline from the header read — an
  idle stream dies at the first event past it unless `ResponseController.SetWriteDeadline(time.Time{})`
  runs first; `http.TimeoutHandler` has no Flusher; `Client.Timeout` covers the body read and cuts the
  stream (`ResponseHeaderTimeout` + an idle watchdog instead); a wrapper `struct{ http.ResponseWriter }`
  without `Unwrap()` hides Flush and buffers the stream to its end.
- **Shutdown:** `Shutdown` never cancels request contexts — open streams hold it to the deadline, then
  drop. `BaseContext` + `RegisterOnShutdown(cancel)`, and main waits for Shutdown to return.
- **Time windows:** a TTL, revocation or backoff promised at production numbers — `synctest.Test`
  proves the number itself; shrinking the config proves only the shape.

## Python — what the sweep cannot see

- **Missing `await`:** a coroutine called without it never runs; a mocked test passes. `asyncio.gather`
  does not cancel siblings on the first failure; `TaskGroup` (3.11+) does.
- **Validation at the edge:** parsed by the model (pydantic) at the boundary. Spec `required` ↔ no
  default; spec non-nullable ↔ not `Optional` (v2: `Optional[str]` without default is required-but-
  nullable). Lax mode coerces `"off"`→False, `true`→1, an int epoch → datetime (s vs ms guessed):
  `strict` where the contract is typed. No `extra='forbid'` against `additionalProperties: false` →
  a forbidden field (`is_admin`) is silently dropped, not refused.
- **FastAPI `yield` dependencies:** an `except` without `raise` swallows (≥0.110); a `StreamingResponse`
  or `BackgroundTasks` using the dependency's session outlives it — they need their own.
- **Numbers:** `float` for money; `/` where `//` was meant — a float lands in an id or page count.
- **Logging:** f-strings carrying the payload into the log (PII, tokens); `logger.exception` only
  inside `except`.

## The gate

The project's CI checks for the touched language PLUS this floor where CI lacks it. Go: `go vet` and
`go test` on the touched packages; `-race` when the diff touches goroutines or shared state (needs
`CGO_ENABLED=1` and a C compiler — unavailable → "-race not run"); `golangci-lint` if configured.
Python: `pytest <touched>`; `ruff` / `mypy` where configured, on changed files. Red on untouched lines
is pre-existing — "Out of scope", not finding one.
