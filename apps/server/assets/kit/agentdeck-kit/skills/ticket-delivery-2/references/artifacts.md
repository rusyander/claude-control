# Every text the run emits

All of it is built FROM the ledger, never from memory or chat scrollback. Published text says WHAT
changed and WHY, impersonally, then stops: no authorship or attribution of anyone, no process
narration, no asides to the reader, no trace of the run's own scaffolding.

## Commit (§9 local, §8 pushed)

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

## Merge request — written ONCE, complete, at §8

By §8 every input exists — §9 verdicts, the §10 table, the §6 gate — so the description is written
whole the first time, never a placeholder filled later. Created as a draft (squash on, source branch
removed on merge), read back (§MR audit), then out of draft in the same sitting. Upload each
screenshot through the forge's own upload call and reference the returned URLs (a GitLab MCP may
expose `upload_markdown` opt-in — absent from the session → `discover_tools`, never "missing"). GitLab
reads the draft state from the title: the undraft is ONE update carrying the title without «Draft: »
AND `draft: false` — `draft: false` alone answers 400 and cost every run a retry turn. Description
(headings in the team's language; the English skeleton below names the parts):

```
Closes [PROJ-777](<ticket link>)

## Problem
## Solution
## Before / after
| Before | After |
|---|---|
## Verification
```

**Verification** is filled from the ledger: which gates ran, what was verified live (the positive
case and the negative one), which bugs turned up along the way and where they were fixed. The tracker
gets the **MR URL only** as its link — never the branch URL, which dies when the branch is removed on
merge.

**Before / after** — one row per ticket with a visible change: BEFORE and AFTER images, uploaded, both
shot on the current base (retaken after a §11 conflict rebase only when the screen's code changed).
No visible change → the row says so and names what was checked instead. **Verification** carries the
§10 `report()` table verbatim — columns `# · Check · Expected · Actual · Result` — headed by the sha
it ran on; a T0 run says "no live run needed: <why>" instead. A hand-built table without the Result
column is a summary, not the verdict.

## MR audit — at §8, before the undraft

Read the MR back from the forge (description as stored, head sha) and hold it against the ledger:
every visual ticket has its two image links in Before / after · the Verification table has the Result
column and its sha is the MR head sha · no placeholder left · every ticket key in "Closes". A miss is fixed
in the description first; the undraft comes after a clean read-back.

## Handoff to a clean session (offered once, right after the §9 local commit)

The conveyor is long and the whole window is re-billed every turn, so the run has one designed
break: review is closed and committed locally, and everything the rest of the flow needs lives in
the ledger and on the branch — not in the conversation.

````
```agentdeck:handoff
{"done":"PROJ-777: fix, review, local commit","next":"Continue PROJ-777 from stage 10 of skill agentdeck-kit:ticket-delivery-2: the live run, then the gate and the MR.","checkpoint":".agent/tickets/PROJ-777.agent.md"}
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

**Files reach the tracker as links, never attachments.** Upload through the forge (`upload_markdown`
or its equivalent) and put the URL in the comment; a Jira attach call answered «updated
successfully» and attached nothing four times running.

**A dependency still unmerged opens the comment.** When the change works only once another MR lands
(a backend half, a contract), the QA comment's FIRST line names it, in the team's language —
`⛔ <dependency> not merged: [MR <iid> — <title>](<url>). Test only after it is merged.` — and the
`12-finish` note
carries `dep: <iid>`. A project fact may fix that wording because a guard greps it; then it is used
verbatim. In prose at the bottom it was missed and the ticket went to test with its dependency open.

## Several tickets in one handover

"do tasks A-1, A-2" = **one branch, one MR**, unless the user asks for separate MRs — then the
conveyor runs once per ticket, in order, one report after the last. Per ticket: §1 claim, its own
ledger, its §3 statements, §10 rows, §12 comment and link. Shared and written into every ledger with
the keys comma-separated: branch, gates, shots, commit, MR, review, pipeline, cleanup. The tier is
computed over the whole diff; a ticket blocked at §1 gets `stop` and stays out of the branch.

## Final report (§14)

In the user's language, short: cause → fix with file links → what was verified live → branch / commit / MR →
tracker status → the pipeline link, "not read" (a state only when the user asked for a read;
"running" is not green). Then, explicitly: every piece the environment did not have, and everything
that was NOT verified, each with its reason. No process narration, no re-listing of the stages.
