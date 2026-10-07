# Data and deploy floor — SQL / migrations / API contract / Helm / K8s

Same contract as [backend.md](backend.md): the canon first, each hit a candidate proven or struck. The
L2 and L3 recipes these rows point to: [live-proof.md](live-proof.md).

## Sweep (`grep -iP` over added lines, the awk of backend.md)

```text
SQL   select \*|offset                         hand-written SQL scanned by position; deep OFFSET scans
SQL   create index(?!.*concurrently)           on a live table: writes blocked for the build
SQL   concurrently                             inside a goose file without `-- +goose NO TRANSACTION`: CIC cannot run in a tx
SQL   concurrently if not exists               a failed CIC leaves an INVALID index; the retry no-ops on it
SQL   set not null|references(?!.*not valid)   full scan under ACCESS EXCLUSIVE; FK locks both tables
SQL   default \((random|gen_random_uuid|clock_timestamp)\(   volatile default: table rewrite
SQL   alter table                              without `SET lock_timeout` (≤2 s) + retry: the queued DDL stalls every later read
SQL   on conflict do nothing returning         with sqlc `:one` — a conflict returns no row → ErrNoRows → 404/500
SQL   pg_advisory_lock\(                       session lock survives ROLLBACK and stays on the pooled connection
Helm  \| default (true|[1-9])                  a user's `false`/`0` is «empty» → replaced by the default
```

`SELECT *` in sqlc / ORM query files is expanded at generate time — not a finding there. New migration
files also go through `squawk --pg-version=17 <file>` (or its Docker image).

## SQL and data access

- **Every list is bounded:** a `LIMIT` from a capped parameter; a new `WHERE`/`ORDER BY` column has an
  index or a statement why the table stays small — `EXPLAIN` at realistic volume, or `sqlc vet` with a
  rule on `Seq Scan` against a scratch DB.
- **N+1:** a query inside a loop over rows (axis-1, cost per call).
- **NULL:** a nullable column scanned into a non-null type fails on the first NULL row; `NOT IN
(subquery)` returns nothing when the subquery yields a NULL. **Empty `IN ()`:** a syntax error or a
  builder that drops the clause and returns everything.
- **Check-then-insert:** SELECT-then-INSERT duplicates under concurrency; `FOR UPDATE` locks only rows
  that exist (no gap locks in PostgreSQL). Unique constraint + `ON CONFLICT`, or advisory lock /
  `SERIALIZABLE` with a retry that re-runs the whole transaction, deciding logic included (under
  SERIALIZABLE a 23505 may be a serialization failure).
- **Error mapping:** `23505`→409, `23503`→409/422, `23502/23514/22P02/22001`→400/422,
  `55P03/57014`→503. Unmapped is a 500, and driver text reaching the client is 🔵.
- **Tenant scope:** every query on a multi-tenant table filters by tenant — one without it is `🔴🔵`.
- **Pooling:** statement / idle-in-transaction timeouts default to 0; pgx's statement cache breaks
  under PgBouncer transaction pooling (→ simple protocol); `KEYS` is O(N); a `SET NX` lock freed by a
  plain `DEL` frees someone else's.
- Rollout order and lock time of a migration: axis-1 §Rollout; the lock queue proven at L2.

## API contract

- **Breaking spec:** `git show $BASE:api/openapi.yaml > $S/b.yaml` then `oasdiff breaking --fail-on ERR
$S/b.yaml api/openapi.yaml` (Docker `tufin/oasdiff`): a removed success code, a new required request
  field, a new response enum value.
- **Handler vs spec:** `schemathesis run spec.yaml --url $SVC --include-path <changed> -c
status_code_conformance,negative_data_rejection,response_schema_conformance,ignored_auth` (exit 1 =
  a finding); FastAPI in-process via `schemathesis.openapi.from_asgi`; Go white-box via
  `openapi3filter.ValidateResponse` in an overlay test.

## Helm / K8s

A new env var, secret, port or volume the code reads exists in the chart for EVERY environment, with a
default or a startup check that fails loudly. A secret value in `values.yaml` or a CI variable echoed
in a job log is `🔴🔵`.

- **Render matrix:** `helm lint --strict`; `helm template . -f values-<env>.yaml` per environment, plus
  `--set list=null` and `n=0`; the rendered set through `kube-linter lint`. The fix for a bool default
  is `ternary .Values.x true (hasKey .Values "x")`; `required` for what must be set.
- **Probes and drain:** liveness that hits the DB or an upstream cascades restarts; a slow boot without
  `startupProbe` kill-loops; SIGTERM → immediate Shutdown drops traffic, because endpoint removal runs
  concurrently — serve N s, then Shutdown, with grace ≥ preStop + drain + stream close.
- **NetworkPolicy:** any `Egress` policy denies everything unlisted, DNS :53 included; a namespace and a
  pod selector in one element mean AND.
- **Scaling:** HPA on a target without resource requests never scales; `replicas:` in the Deployment
  resets the count on every apply; PDB `minAvailable` > HPA `minReplicas` blocks drains.
