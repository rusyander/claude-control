# Report shape — the findings file, the digest, the handoff

A **work list**, not prose: a fix agent picks it up unattended, so every finding is self-contained
(path, line, evidence, fix, status) under a stable id. Its length follows the findings — what the diff
does not show, and nothing that restates it.

## Where it goes, and what the hook refuses

`.agent/reviews/<scope-slug>.agent.md`, slug = branch, MR iid or module path. Structured keys and
values below are fixed English tokens (the tools parse them); the prose under them — theses, reasons,
fixes — is in the user's language. The guard checks the file at Write, and at Stop when a shell
command wrote it. Refused: a missing `Tier` · `Radius` · `Verified` · `Taken on trust` · `Score`; a
finding without `Where` / `Axis` / `Status`; a 🔴/🟡 without `Evidence`; T2 with a `Live` line naming
fewer than two variation classes and no "not run — <why>"; a T2 🔴/🟡 naming no rung (`L1`…`L4`, or
`L0 — <why>`); T1/T2 without `Coverage`, without all eight `Passes` keys, without a counted
`Acceptance` or `Ledger`, or with a `Classes` line short of its six keys; "no blocking findings", LGTM
or "ready to merge" while `Coverage` names a gap or `Ledger` counts short; a pass that struck nothing
and says nothing (`**Dropped:** none — <why>`). An `Edit` of an older report may only fail to remove
what the file has.

**A second review of the same scope reuses the file** — ids stay, closed ones keep status and reason,
new ones continue the numbering; a `fixed` it meets is confirmed the way it was opened.

## Order — the reader stops early, so order is the deliverable

1. **What was checked** — the coverage ledger per zone, one verdict row per radius consumer (`checked
at file:line` · `unaffected, because …` · `not checked`), the acceptance matrix, the commands run.
   Each candidate that died under proof: one `- ✗` line naming the paths its defence covered.
2. **Verdict on the stated** — does it do what the MR says; bugs genuinely fixed, with evidence.
3. **Findings** — the 🔵 security block first, then 🔴 · 🟡 · ❓.
4. **Out of scope** — what the surrounding code revealed; same format, ids continue.
5. **Done well** — one or two items, honestly.
6. **Nits** — every 🟢, compact.

## Skeleton

```markdown
# Review: <what was reviewed> — <base: sha / branch>

**Base:** <base sha> · **reviewed head:** <reviewed head> · **current head:** <head now>
**Tier:** T2 — lifted by: access and ownership (`middleware/auth.go`), code without a test beside it
**Radius:** consumers 7 · entry points 2 · over the cap 0 — a verdict for each in "What was checked"
**Coverage:** api-gateway fully · admin-ui partly (`pages/Users/*` not read) · helm not read; radius
209/209, not searched 0; lanes 4 — found 31, estimate ≈52
**Passes:** promises — exit table, F-03 · config — `values.yaml` 14 keys × 0/empty · parse — n/a: no
new parsers (`rg 'Unmarshal|parse'` 0) · registries — role×action 6×9 · deviance — 3 queries to
`sessions` · claims — detector differential 1125 lines · history — `git log -S'maskAll'` · attacker —
long input, `%2F`, replay
**Acceptance:** 14 criteria — met 9 · partly 2 · not met 1 · uncheckable 1 · out of frame 1
**Ledger:** 461/461 files · lanes 4 · rounds 3 · remainder estimate ≈6 (`review-plan.mjs check`)
**Classes:** siblings — `rg 'limit' svc/send.go` 2 → F-01 · parity — 3 calls compared · hang — n/a:
response holds no one-time data · before gate — `limiter.go:40` · environment — n/a · contract —
`openapi.yaml:88`
**Verified:** <commands actually run; files actually read>
**Live:** <two variations of DIFFERENT classes — delay · role without the right · empty state · bad
input; or "not run — <why>">
**Taken on trust:** <what could not be checked and why>
**Summary:** 🔴 4 · 🟡 6 · 🟢 3 — blocking: F-01, F-04, F-07, F-11
**Score:** raised 17 · published 13 · confirmed by author <after replies>
```

`Passes` answers SKILL §2 key by key — the command, the table or `file:line`, or "n/a — <the search
showing no trigger>". `Classes` answers axis-1 §Six miss classes the same way.

<example>
```markdown
## F-02 🟡🔵 The block is lifted by `AttemptWindow`, not by `BlockDuration`

- **Where:** `shared-security/bruteforce/bruteforce.go:131-135`
- **Axis:** correctness
- **Evidence (L1 — run):** `MaxAttempts=3`, `AttemptWindow=200ms`, `BlockDuration=10s`:
  ```
  after 3 failures: IsBlocked=true, BlockDurationRemaining=10s
  after 250ms + one more failure: IsBlocked=false (BlockDuration=10s still running)
  ```
- **Why it matters:** resetting the attempt window also clears `isBlocked` — on production defaults
  the attacker lifts the block with their own next attempt.
- **Fix:** `if !info.isBlocked && time.Since(info.firstAt) > p.attemptWindow { … }`
- **Status:** open

### F-14 🟢 `data` says nothing about the content — `sessions`

- **Where:** `ui/SessionList.tsx:12` · **Status:** open
- **Axis:** style

```
</example>

The thesis is a claim, not a topic; the evidence is pasted output; the fix is code. A security finding
carries both marks and sits in the security block. A ❓ keeps the shape — the question in place of
**Why it matters**, the settling investigation in place of the fix.

## Status and the computed lines

Ids are never reused: user, fix agent and MR threads share the name. `Status`, owned by the fix agent
afterwards: `open` → `accepted` (the author agreed in the thread — written by `review-sync`,
unverified) → `fixed` (the evidence re-ran; what changed, no commit) | `rejected` (why) | `deferred` |
`closed` (a ❓ answered). `fixed` is closed the way the finding was opened — rerun, requote, re-grep.

`Summary` and `Score` are **computed**: `node <kit>/tools/review-score.mjs <report> --write`, and the
hook refuses a header contradicting the file. With a gap in `Coverage`, `Summary` reads "blocking: none
in what was read — coverage incomplete". `raised` = findings + every `- ✗` line; `published` =
findings with `- **Thread:** <url>` (added when the thread exists); `confirmed by author` = published
at `accepted` or `fixed`.

What happens to the file afterwards: [handoff.md](handoff.md).
```
