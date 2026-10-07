# Axis 2 — the frame as the thing under test

Disclosed reference for `agentdeck-kit:deep-review` §3. Inline there: (a) requirements missing or partial, (b)
behaviour nobody asked for, (c) requirements that look done but whose implementation reads wrong —
answerable against any frame, however thin. (d)–(g) need a **real** frame (a ticket, an epic,
a spec, an MR description), and they are the ones skipped when the frame is read as background instead of
as an authority. Each is answered with the frame's own line quoted, exactly as (a)–(c) are.

## (d) Coverage of the frame itself

Both directions. The frame → the code catches the unfinished; the code → the frame catches the
unannounced. Walk the commit list and the changed-file list against the description: **a commit the
description never mentions is a finding** — reviewer and QA do not know it is there, so nobody plans to
test it, and it is the change most likely to ship unlooked-at. A refactor folded into a bugfix MR, a
dependency bump, a config edit, a "while I was here" rename all surface here.

Evidence is the pair: the file or commit, and the absence quoted — what the description says instead.

## (e) A requirement that is itself wrong

Built faithfully and still harmful: the spec asks for a default that loses data, a flow that leaks an
identifier, a rule that contradicts one the product already has. The author did their job; the finding
is **against the frame, not against them**, and it is addressed to whoever owns that decision.

Keep it at its real severity — a wrong requirement implemented correctly breaks production exactly as
hard as a bug. Say what the frame asks, what happens when it runs, and who has to decide.

## (f) The description's own factual claims

An MR description makes claims about code, not only about intent: "behaviour unchanged", "the backend
already sorts this", "the existing test covers it", "this endpoint is not used yet". Each is checkable.

Confirm every one at `file:line`, or name it unverified in "Taken on trust". **The most convincing claim
is the one believed unchecked**: it is what persuades the reviewer to skip the very file that needs
reading. A claim that turns out false is a finding at the severity of what it was covering for.

## (g) The acceptance matrix

The frame is walked as a checklist, not read as background. Sources, all of them: every ticket the MR
names (tracker issue read; the panel bridge: `jira_issue`), every child of an epic it closes (`jira_search` on the parent), each spec
section in scope by line number, the project rule docs whose paths the change touches. One row per
acceptance criterion:

| criterion, quoted                     | source    | site                  | verdict | evidence                         |
| ------------------------------------- | --------- | --------------------- | ------- | -------------------------------- |
| "Reading content — only with right X" | PROJ-1023 | `handler/files.go:88` | not met | `curl` as a role without X → 200 |

Verdicts: **met** · **partly** · **not met** · **uncheckable** (why) · **out of frame** (which MR
carries it). "Met" needs evidence at the rung the criterion's claim needs — a permission, time or
failure promise is proved by action (SKILL §4), and a handler that reads right is "uncheckable" until
it runs. A criterion that spans read and write, UI and API, or several roles gets a verdict for each
side; one side checked is "partly". Every "partly" and "not met" is also a finding under (a).

The report counts the matrix on one line — `**Acceptance:** 14 criteria — met 9 · partly 2 · not met
1 · uncheckable 1 · out of frame 1` — and carries the table in "What was checked". No frame at all →
`**Acceptance:** no frame — <what was searched: description, linked tickets, epic, README>`.

A real case: PROJ-1023's criterion covered reading content; only enabling storage was checked, and the
pass wrote "RBAC — checked". The epic's ~50 child tickets were never opened. Both were 🔴 findings
colleagues raised from the ticket text alone.

## (h) The contract entry — the second way in

(a)–(g) start at the frame and still end up reading the code the diff shows. This one starts at what
callers and readers are told, and ends at the running service, never at the handler's text. One team's
blocker table: docs ≠ code, 18 MR blockers, the largest class — each a doc taken as true
because the diff looked right. Mandatory at every tier; it needs no ticket.

1. **Sources, before the diff is opened**: contract files (OpenAPI, proto, JSON/zod schema, a shared
   contracts package), API docs, README, in-app help, doc comments on exported API, the ticket's
   acceptance. Found by grepping every changed route, field, error code, env var and limit name across
   them — a doc the diff edits counts, one it left alone counts more.
2. **Claims**: each statement about the changed behaviour — status code, field name and type, error
   shape, limit, default, ordering, who may call it — one row of the (g) matrix, source = `doc:line`.
3. **Checked by request**: to a stand running the reviewed head (L4, from the scratch clone), or the
   route's integration test through the real route (L2). The row quotes the request and the observed
   status/body line beside the doc's. Reading the code gives no verdict: without a request the row is
   "uncheckable — <why no stand>", never "met".
4. **Both directions**: doc says X, service does Y → finding; behaviour changed and the doc still
   describes the old → finding, the doc now lies. A broken public contract is 🔴 (SKILL §5).

The `Acceptance` line carries its count: `… · contract 7 claims — by request 6, uncheckable 1`; none
found → `contract: none — <what was searched>`.
