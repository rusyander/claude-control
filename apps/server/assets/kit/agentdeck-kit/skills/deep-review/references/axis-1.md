# Axis 1 — the checks a diff shows cheaply and production shows expensively

Each is correctness, not a separate audit: the diff is already open, and the cost of missing one is
paid at 3am by someone else.

## The security surface

Few questions, and the diff answers them:

- **Access** — the new route declares its permission explicitly, and the operation checks tenant and
  owner before touching a row. Identity comes from the verified token or the mTLS context; a header,
  a query param or a body field claiming who the caller is proves nothing.
- **Injection** — every value reaching SQL, a shell, a path or a template is parameterized or escaped.
  An id from the URL is validated before it becomes a filename.
- **Secrets and PII** — neither in logs, error bodies, metric labels or URLs; no key in the repo. An
  error returned to the client carries a code, not the driver's message.
- **Sessions and tokens** — expiry, rotation, revocation on logout, cookie flags; a token in a URL is
  a token in someone's access log.
- **Uploads** — bounded size and type, and a stored name the user does not control.
- **Crypto** — the standard library's primitives; a hand-rolled one is the finding.

A finding here carries 🔵 next to its severity and goes into the report's security block. Where the diff
touches authentication, authorization or the RBAC map, one review pass is not enough — offer
`/security-review` on top of it.

## Cost per call

Work that grows with the data: a query inside a loop, a full scan where a key lookup exists, an O(n²)
join over a list that arrives unbounded, blocking I/O on a hot path, a payload with no page limit.
Judge the _shape_, not a benchmark — name the input size that makes it hurt. A measured slowdown
already in front of you is a different job: `agentdeck-kit:perf-audit`.

## Failure visibility

When this breaks at 3am, does anything say so? A swallowed exception, a catch that logs nothing, an
error path with no log line or metric, a retry that hides a permanent failure, a spinner that spins
forever because the error went to the store and nowhere else. Silence turns one bug into an unbounded
one. The log line itself is subject to review: it carries the identifiers needed to find the request
and none of the payload.

## The tests the change brings

A test that passes without the fix guards nothing, so prove it the way the fix is proved: run the test
alone against the base commit and watch it fail. Ways a test passes for the wrong reason:

- the assertion lands on a mock the test itself configured;
- a snapshot regenerated in the same commit as the change;
- the case exercises a path the bug never took;
- the expectation is zero or empty, and the code returns zero or empty for an unrelated reason.

The project's own practice sets the bar. No suite for this layer, or no suite anywhere — the absence is
not a finding, and demanding one is asking for a new practice rather than reviewing a change; note it
once in "Out of scope" if it matters and move on. Where the layer _is_ tested, a fix arriving without a
test is a finding — name the case that is missing, not the absence in general.

### Count is not coverage

A test earns its place by the failure it can cause; a thousand that fail together cost CI minutes and
trust and guard less than ten that fail for distinct reasons. Ask what is lost by deleting it. Dead
weight, 🟡 when this change adds it, 🟢 when it was already there:

- **The same defect guarded twice** — unit and integration reaching one line; keep the cheapest that
  localizes the failure.
- **Cases differing only in data** — one row per _branch_, not per value.
- **Change detectors** — call counts, argument order, internal names: red on every refactor, silent on
  every defect. Assert what the caller observes.
- **Testing the dependency** — that `zod` rejects, the router renders, the ORM saves.
- **Coverage filler** — a call with no real assertion ("does not throw").
- **Wide snapshots** — a whole tree names no defect when it breaks; regenerated, the guard is gone.
- **An assertion that cannot fail** — the expected value computed by the code under test.

Settle it by breaking what the test claims to guard: invert the condition, return early, drop a field,
then run the file. Whatever stays green guards nothing, however many cases it holds. Do this to the
suite the change brings — auditing the pre-existing suite is its own task, and a note in "Out of scope".

## The lines the change removes

Reviewers read `+` and skim `-`, which is why the sweep greps both sides. A removed guard, a deleted
cleanup (`clearTimeout`, `revokeObjectURL`, `defer`, `Close`), a dropped validation, a test deleted
rather than updated, an early return that used to short-circuit. For every removal, one question: what
used to happen here, and who relied on it?

## Rollout order of a schema change

A migration and the code that uses it land in one MR but not in one instant. During a rolling deploy
the old code runs against the new schema, and the new code against the old one for the moment before
the migration applies. Dropping or renaming a column, tightening a constraint, changing a type — each
needs the two-step shape (add → backfill → switch → drop in a later release), or an explicit statement
that this service takes downtime. Two more per migration: is it reversible, and how long does it hold
a lock on the table at production row count?

## Where the mouse goes, the keyboard goes

Frontend diff: a click handler with no keyboard path, an ARIA role declared without its focus contract
(moved, trapped, returned). Flag what the diff introduces; a full sweep is `agentdeck-kit:a11y-audit`.

## Six miss classes (calibrated on 4 merged MRs: 7 finds only humans made)

Each is answered in the report's `**Classes:**` line with the command run or the `file:line` read; "n/a"
names the search that shows it. New misses arrive as `review-sync` "Found by others" rows ([handoff.md](handoff.md)).

- **Siblings** — a proven finding → grep its shape in the same function, file, parallel handler. MR based
  on a sibling branch → that review's `## F-` headings first, each class re-checked here. (!691: second
  limit in the same loop; !690 repeated the class raised on !689.)
- **Parity, both directions** — (a) new caller of an endpoint/hook/mutation → diff its handling against
  the other callers (response flags, error cases, messages, invalidation); (b) new value a producer
  emits — error code, enum member, status, field → grep every consumer map (client error registry,
  switch, i18n keys). Zero hits outside the diff is the candidate, not «no coupling». (!724 third caller
  dropped `synced:false`; !690 new code absent from `PUBLISH_ERROR_KEY`.)
- **Hang with irreversible state** — a response carrying what cannot be fetched again (one-time secret,
  created id, charge) is shown or stored before the next await; a wait the user cannot leave is
  bounded. A shared client without timeouts is one "Out of scope" row per project, not a row per call.
  (!724 secret shown only after a second `PUT`.)
- **Before the gate** — work placed above a rate limit, auth or size cap is cheaper than the gate; a
  «cheap / cached / pure» comment is verified at the callee's source or a 1000× loop. (!691 uncached
  `time.LoadLocation` above the limiter, under a comment calling it cheaper.)
- **Environment** — a new OS package, env var, mounted file or sidecar is embedded or checked at
  startup. Present in the image today → 🟢 hardening; absent anywhere it runs → 🔴. (!691 tzdata →
  `import _ "time/tzdata"`.)
- **Contract ↔ validator** — spec (OpenAPI, JSON schema, proto) against the code enforcing it, field by
  field, both directions: every `required`, bound and enum enforced; everything enforced declared.
  (!691 `content` required in the schema, accepted missing.)

Backend diff: the project's canon first, then [backend.md](backend.md) as the floor.
