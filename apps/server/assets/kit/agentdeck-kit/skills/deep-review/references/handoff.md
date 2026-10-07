# The findings file afterwards — the fix agent, and closing a finding

Disclosed reference for `agentdeck-kit:deep-review` §5. Reached once the report exists: it is being handed to a fix
agent, or the author has replied. Writing the file itself: [report-shape.md](report-shape.md).

## Handing off to a fix agent

Spawn it with the file as its only input; no re-review. English prompt:

```
[return-format] ≤10 English lines: id → verdict. [no-subagents]
Read .agent/reviews/<slug>.agent.md. Fix findings in severity order, 🔴 first, one at a time.
Before each fix, grep the finding's shape in the same function, the file and the parallel handlers;
fix every copy or list the ones left. Apply the proposed fix where it is right; where it is wrong,
fix the underlying problem and say so.
Backend (Go/Python/SQL/Helm/CI) is editable ONLY under this grant for THIS task: <files | none>.
No grant → leave Status open, add "backend fix needed: <file:line>, no permission".
After each: set Status to fixed/rejected/deferred with one line of reason; `fixed` = the finding's
evidence re-ran and now passes. Skip anything already non-open. Run the project gate once at the end.
```

The grant line is filled from the user's yes BEFORE the spawn — never assumed (kit safety rules).
Unproved findings stay questions — the fix agent investigates, never edits on a guess.

## After the author replies

Once the author answers, the findings file goes stale. First pull the threads back:

```bash
node <kit>/tools/review-sync.mjs .agent/reviews/<slug>.agent.md          # dry run: what changed
node <kit>/tools/review-sync.mjs .agent/reviews/<slug>.agent.md --write  # Thread/Synced lines, flips, "Found by others"
```

It never writes `fixed`. The MR author's last reply reading as done ("Done", "Fixed in <sha>")
flips `open → accepted` — the author's word, counted in `confirmed by author`, not yet verified; `accepted →
fixed` is yours, by rerunning the evidence. Silence, a resolved thread, a ❓, a deferral ("in the next
MR", "separate task"), a partial ("except", ", but …") never flip: every `DECLINED` / `DEFERRED` /
`READ` row it prints is settled by the rules below. A `tie` or `unmatched ours` row is a thread it
could not pair — add its `- **Thread:**` line by hand, the next sync reads the link first.

Once a report holds a `Thread` line on a finding still open|accepted, session start (the kit's `review-sync-brief` hook) runs `--all` as a
dry run in the background once a day and prints one `Review sync:` line
when the author answered or others opened threads since the last line — relay it; `--write` stays the
user's call.

Each "Found by others" row is a CANDIDATE miss (after our first note, never answered by us). Not a miss:
a finding of this report with the same place or thesis; a thread on code pushed after the reviewed
head; a nit outside axes 1–3. Say which, one indented line under the row — the sync keeps it. The
rest get a class from axis-1 §Six miss classes, or a new class written into the profile journal: a
miss nobody classifies is repeated. `--all .agent/reviews` is the calibration view — accepted ·
declined · deferred · unclear, and "share of others' threads", which is a share, not recall.

The reviewer who opened a finding closes it; only four things do:

- the author's answer settles a ❓ → `Status: closed` plus the answer in one line. That answer is an
  unwritten contract — it belongs in the profile journal, not only in the thread.
- the author is right → `rejected`, with what changed your mind; no re-litigation.
- the author is wrong → the thread stays open at its severity; repeat the evidence, never the claim.
- the fix lands → confirmed by rerunning the evidence, then `fixed` (from `open` or `accepted`).

Done = no finding `open`; the digest names how many were fixed, rejected, closed by answer. A
half-flipped file is worse than none: the next review trusts it and re-raises the settled.
