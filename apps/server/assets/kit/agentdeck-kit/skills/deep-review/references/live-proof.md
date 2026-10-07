# Live proof — the ladder, with recipes

A claim is proved at the lowest rung that EXECUTES the behaviour it is about. Green on a lower rung
leaves a higher-rung claim open as ❓: a handler that reads right says nothing about what it does when
Redis hangs. Every probe first goes red — at the base commit, or on an input that must fail — before
its green is quoted. `$S` = `scratchpad/review-<slug>`; the reviewed tree is never written. Whatever a
rung starts is stopped in the same turn.

| the claim is about                                                                                                      | rung |
| ----------------------------------------------------------------------------------------------------------------------- | ---- |
| a line, a caller, a value, what a doc promises                                                                          | L0   |
| logic, coercion, a handler's status, streaming in-process, shutdown, a leak, a time window in virtual time              | L1   |
| database semantics — locks, error codes, `ON CONFLICT`, isolation, migration lock and duration, a plan                  | L2   |
| the process under fault — fail-open, end-to-end timeouts, a stream when upstream resets, drain, a measured time promise | L3   |
| topology — NetworkPolicy, probes and rollout, HPA, ingress buffering, the IdP                                           | L4   |

The `**Live:**` line names the rung each 🔴/🟡 reached; a rung not reached is named with its reason.

## The exercise sweep — T2, before any suspicion

The ladder runs after a candidate exists; the sweep runs what nobody suspected. Each changed entry
point — route, CLI, exported function, screen — once on a happy input and once per hostile one: empty,
max, duplicate, unauthorised, malformed. One ledger row each, `input → observed`; a surprise is a
candidate, and a point that cannot run says why.

## L0 — cite and search

`file:line`, a grep with its command and its count. Closes static facts; never timing, concurrency,
locks or lifecycle.

## L1 — scratch probe on the repository's code

Go, white-box, no checkout — `-overlay` adds a test file and swaps base ↔ head for one file:

```bash
git -C "$REPO" show $BASE:pkg/x/f.go > $S/f_base.go
printf '{"Replace":{"%s/pkg/x/zz_review_test.go":"%s/probe_test.go"}}' "$REPO" "$S" > $S/head.json
# base.json = head.json plus "$REPO/pkg/x/f.go":"$S/f_base.go"   (Windows: absolute C:/… paths)
go test -C "$REPO" -count=1 -overlay $S/base.json -run TestReview ./pkg/x   # red
go test -C "$REPO" -count=1 -overlay $S/head.json -run TestReview ./pkg/x   # green
```

Python: `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=$REPO/src python -m pytest -p no:cacheprovider
$S/test_probe.py`. Frontend: P0–P7 of [frontend.md](frontend.md); a workspace package whose `dist`
lags its source answers for the wrong code — `node <kit>/tools/review-harness.mjs fe-config --repo
$S/clone --app <app dir> --out $S/vitest.review.mts`, then `npx vitest --config $S/vitest.review.mts`.
Streams: `httptest` with the server's real timeouts, an event after the deadline; shutdown: time
`Shutdown` with a stream open. Mutation on the diff — always on a scratch clone, since every tool
writes into its tree: `node <kit>/tools/review-sweep.mjs mutants --repo $S/clone --base $BASE
--out $S/mut.json` plans negated conditions, moved boundaries, `return err → nil`, n+1 over the
changed lines, then `node <kit>/tools/mustfail.mjs --cwd $S/clone --cmd "<test cmd>" --mutants
$S/mut.json` (own identity control; a survivor is a behaviour no test pins); JS alternative `npx stryker run cfg.json --mutate "<file:from-to,…>"`; Python cosmic-ray with an absolute
interpreter and `cosmic-ray baseline` first — a bare `python` fails the baseline silently and reports
0% survival. gremlins and pytest-gremlins print efficacy they never measured. Fuzz a changed parser:
`go test -run=^$ -fuzz=FuzzX -fuzztime=60s`. Changed lines no test executes: `diff-cover cov.xml
--compare-branch=BASE` — then mutate them, since executed is not asserted. Leaks: `goleak.VerifyNone` or the `goroutineleak` profile (Go 1.27). A promise AT a number: `synctest`
virtual time proves the number, not only the shape.

## L2 — real dependencies in throwaway containers

The Docker rule block arrives before the first `docker run`; every container carries the label.

```bash
L=claude.ephemeral=review-<slug>
docker run -d --rm --label $L --name rv-pg -e POSTGRES_PASSWORD=p -p 127.0.0.1::5432 postgres:17-alpine
until docker exec rv-pg pg_isready -U postgres; do sleep 1; done
git -C "$REPO" archive $BASE migrations | tar -x -C $S/base
for f in $S/base/migrations/*up.sql; do docker exec -i rv-pg psql -qv ON_ERROR_STOP=1 -U postgres < "$f"; done
```

The lock queue of a migration, three sessions: A a long read (`SELECT pg_sleep(20) FROM t LIMIT 1 &`),
B the new migration (`&`), C `\timing` + a plain `SELECT` one second later. Red: C waits ≈ A's
duration behind B. Green: B fails `55P03` at its `lock_timeout`, C returns at once. Also up → down → up
with a `pg_dump -s` diff; `INSERT … SELECT generate_series` for volume before any timing or `EXPLAIN`.
Cleanup: `docker rm -f $(docker ps -q --filter label=$L)`.

## L3 — the service from a scratch clone, behind a fault proxy

`H=<kit>/tools/review-harness.mjs` — the stand as commands; every container it starts carries the
label, every fake it starts is recorded, `down` removes both.

```bash
node $H clone --repo "$REPO" --sha $HEAD --to $S/clone          # reports paths Windows cannot hold
node $H fake-upstream --mode sse-cut --after 3 --port 19001 --slug <slug>   # background; or ok|sse-eof|sse-split|hang|slow-headers|status
node $H proxy up --slug <slug> --listen 16379 --upstream 127.0.0.1:6379     # toxiproxy, 127.0.0.1 only
go build -C $S/clone -o $S/svc.exe ./cmd/svc && (REDIS_ADDR=127.0.0.1:16379 $S/svc.exe & echo $! > $S/pid)
node $H proxy fault --slug <slug> --kind timeout            # latency|timeout|reset|slow-close|bandwidth|slicer|limit-data
node $H probe stream --url $SVC/v1/messages --method POST --body req.json --timeout 30000
node $H proxy reset --slug <slug>; node $H down --slug <slug>   # and kill $S/pid
```

`probe stream` prints status, time to headers, chunks, events, whether the terminal event arrived, and
how it ended — `end` · `eof-without-terminal` (a truncated 200) · `reset` · `timeout` · `client-abort`
(`--abort-after <ms>`: does cancel reach upstream?). Faults: `timeout` (ms 0) — a black hole that
hangs where a refused port fails fast, exposing fail-open and missing timeouts; `reset` — RST;
`limit-data --bytes N` — a cut mid-body; `slicer` — frames split across reads; `latency --ms` — a
window, measured, never read. A fake upstream shapes the break itself: `sse-split` cuts inside a
multibyte char and a frame, `sse-eof` closes cleanly without the terminal event. Differential: the base
binary from a second clone at `$BASE`, the same corpus against both, bodies diffed. Contract fuzz
against the running service: schemathesis, [data-deploy.md](data-deploy.md).

## L4 — the stand

Only topology claims. Read-only by default: `kubectl get netpol,hpa,pdb -o yaml`, `kubectl exec
deploy/x -- wget -qO- -T3 <upstream>`, events with `reason=Unhealthy`, `curl -N` for the first byte
of a stream. A pod kill or a rollout on a shared stand is a per-operation yes. A sick stand → skill
`agentdeck-kit:stand-doctor`. Logins stay few: a failing credential is tried once, never looped. Local topology:
`kind create cluster --name rv-<slug>`, a deny-all that must fail first (proves the CNI enforces
NetworkPolicy), `kind delete cluster` after.
