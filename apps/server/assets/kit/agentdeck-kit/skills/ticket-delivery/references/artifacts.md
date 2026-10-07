# Every text the run emits

All of it is built FROM the ledger, never from memory or chat scrollback. Published text says WHAT
changed and WHY, impersonally, then stops: no authorship or attribution of anyone, no process
narration, no asides to the reader, no trace of the run's own scaffolding.

## Commit (§8)

Conventional subject with the key in parentheses, body in the user's language:

```
fix(<scope>): <what changed> (PROJ-777)

<why, and what was wrong — 1-3 lines>

- <change 1>;
- <change 2>.
```

`git commit -F-` with a blank line after the subject. Escapes belong here as their own lines when
the change genuinely carries no behaviour or no doc surface, one per file where the project's gate
demands a path: `Tests-Impact: none — <path> — <reason>` · `Docs-Impact: none — <reason>`.

## Merge request (§8 draft, §12 final)

Created as a **draft**, squash on, source branch removed on merge. Upload each screenshot through
the forge's own upload call and reference the returned URLs. Description (headings in the team's
language; the English skeleton below names the parts):

```
Closes [PROJ-777](<ticket link>)

## Problem
## Solution
## Before / after
| Before | After |
|---|---|
## Verification
```

**Verification** stays a placeholder until §12, then is filled from the ledger: which gates ran, what
was verified live (the positive case and the negative one), which bugs turned up along the way and
where they were fixed. The tracker gets the **MR URL only** as its link — never the branch URL,
which dies when the branch is removed on merge.

**Before / after** — one row per ticket with a visible change: BEFORE and AFTER images, uploaded, both
shot on the current base (retaken after a rebase). No visible change → the row says so and names
what was checked instead. **Verification** carries the §10 `report()` table verbatim — columns
`# · Check · Expected · Actual · Result` — headed by the sha it ran on. A hand-built table without
the Result column is a summary, not the verdict.

## MR audit — before the undraft (§12)

Read the MR back from the forge (description as stored, head sha) and hold it against the ledger:
every visual ticket has its two image links in Before / after · the Verification table has the Result
column and its sha is the MR head sha · no placeholder left · every ticket key in "Closes". A miss is fixed
in the description first; the undraft comes after a clean read-back.

## Handoff to a clean session (offered once, right after §8)

The conveyor is long and the whole window is re-billed every turn, so the run has one designed
break: the MR is pushed, CI is off and running, and everything the rest of the flow needs lives in
the ledger and on the branch — not in the conversation.

````
```agentdeck:handoff
{"done":"PROJ-777: fix, gates, draft MR !123","next":"Continue PROJ-777 from stage 9 of skill agentdeck-kit:ticket-delivery: two-agent review, then the live run.","checkpoint":".agent/tickets/PROJ-777.agent.md"}
```
````

**The ledger IS the checkpoint** — the handoff is refused unless that file exists inside the project
and was written during this run, which is exactly what `ticket-ledger add` does every stage. `next`
becomes the first message of the new session, so it names the ticket and the stage to resume at,
never a retelling of the conversation. The chain is capped at five. Wiping context on the model's
own decision is lost work, not saved tokens: the user decides whether to continue.

## Shots folder README (§7)

In `.agent/screenshots/before-after/<key>-<slug>/README.md`: what the defect was, what changed, and
a table of the files touched. One AFTER image is re-read to confirm it is legible before it ships.

## QA comment (§12)

In the team's language, for a QA who may also work through an agent, so it is executable rather than
prose (headings translated, structure kept):

```
## What to check
Stand: <url> · role: <account> · where: <section → screen>

| # | Step | Expected result |
|---|------|-----------------|

## Negative checks
| # | What to break | How it must respond |
|---|---------------|---------------------|

## Affected
<sections worth a regression look>
```

Steps and negative rows are copied from the §10 acceptance table, not rewritten. MR references in
tracker text are `[MR 825 — <title>](<url>)`, never `!825`, and the posted comment is read back —
situational rule `forge-protocol`. Screenshot links
come from the upload URLs; underscores in a forge URL are percent-encoded where the forge demands
it. No tracker ⇒ this block goes into the MR description instead, and the report says so.

## Several tickets in one handover

"do tasks A-1, A-2" = **one branch, one MR**, unless the user asks for separate MRs — then the
conveyor runs once per ticket, in order, one report after the last. Per ticket: §1 claim, its own
ledger, its §3 statements, §10 rows, §12 comment and link. Shared and written into every ledger with
the keys comma-separated: branch, gates, shots, commit, MR, review, pipeline, cleanup. The tier is
computed over the whole diff; a ticket blocked at §1 gets `stop` and stays out of the branch.

## Final report (§14)

In the user's language, short: cause → fix with file links → what was verified live → branch / commit / MR →
tracker status → the pipeline link, with its state only if §12 read it ("running" is not green). Then,
explicitly: every piece the environment did not have, and everything that was NOT verified, each
with its reason. No process narration, no re-listing of the stages.
