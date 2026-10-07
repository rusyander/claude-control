# Publishing a review to the forge (GitLab / GitHub)

Route: a GitLab or GitHub MCP server if one is configured (any name), else the user's own `glab` / `gh`
login (`glab api`, `gh api`). Neither connected → say "forge not connected — log in with glab/gh" and
hand the user the findings file instead. Tool names below are the GitLab MCP ones; the CLI forms hit
the same REST endpoints (`projects/:id/merge_requests/:iid/{versions,discussions,draft_notes}`).

Reads are free; **every write waits for an explicit yes** — one confirmation covering the whole batch,
named concretely ("posting the summary + 13 inline threads to MR '<title>'"). The
comment is read by the whole team and the author is a live human: there is no "harmless" note that
skips the confirmation.

Comments are addressed to the **MR author** (`author.username` on the MR), who is not always the author
of the commits. Check both before writing "you did …".

## 1. Take the shas and re-read the threads before writing anything

`list_merge_request_versions` / `get_merge_request_version` → `base_commit_sha`, `start_commit_sha`,
`head_commit_sha`. Every inline note carries all three; a note built on stale shas lands on the wrong
line or is rejected outright. A head that moved since the review started (a bot commit, a force-push)
is said out loud — the findings are about the sha that was read, not the one that is current.

Then `mr_discussions` again, **immediately before the first write**, and every finding is diffed
against what is already there. Reviews land while yours is being written: on one real MR the list read
at the start returned only system notes, two humans had reviewed in the meantime, and three of their findings
went out a second time. Anything a human already raised is dropped, or answered in their thread instead
of opening a new one. A `review-publish-guard` hook denies the write when this read is missing or older
than fifteen minutes, and after a refusal only a discussions read made AFTER it opens the gate —
repeating the call opens nothing.

## 2. Draft first, publish once

`create_draft_note` per finding → user reads them → `bulk_publish_draft_notes`. One notification for the
author instead of thirteen, and the batch is reviewable before it becomes public.
Direct route when drafts are not wanted: `create_merge_request_thread` per finding (resolvable thread,
which is what a review comment should be), `create_merge_request_note` for the non-positional summary.

## 3. Position object — inline anchoring

```json
{
  "base_sha": "…",
  "start_sha": "…",
  "head_sha": "…",
  "old_path": "src/x.ts",
  "new_path": "src/x.ts",
  "position_type": "text",
  "new_line": 42,
  "old_line": null
}
```

- line **added** by the MR → `new_line` only, `old_line: null`
- line **removed** → `old_path` + `old_line` only
- **context** line (unchanged, still worth commenting) → both `old_line` and `new_line`
- file renamed → `old_path` ≠ `new_path`

An added line is the most reliable anchor: prefer moving a comment onto the nearest added line and
naming the other places in its text. A finding outside the diff has no valid position — it goes into the
summary note's "outside the diff" section, never forced onto the nearest changed line.

## 4. How many threads

One finding = one thread, at its most telling site; the same problem in three files is that one thread
plus a list of the other two in its text, not three notifications.

Nits do not get to fill the feed: one to three of them go as threads, a dozen go as a single folded
list in the summary note. The visual weight of a comment is itself a severity signal.

## 5. Order and wording

Summary note first, inline threads after: the author gets the frame before the details, and the summary
can name which findings block precisely because it is read first. It carries what was checked (commands
run), the verdict on the claimed change, what blocks, what is at the author's discretion, anything
outside the diff — and the praise, in one paragraph. Praise inside threads gets in the way of reading.

A thread is three short parts: **fact → consequence → proposal.**

> `setBlobs([])` clears the list here, but the blob URLs are never revoked — `revokeFileItemUrl` runs
> only on manual removal. After every send with attachments the files stay in the tab's memory until a
> reload.
>
> Suggest closing it inside `useAttachments` — that fixes every composer, not just this one.

Describe the code, never the author: no "wrong", no "why did you". A ❓ finding is published as a
genuine question — the author's answer closing it is a normal outcome. What the author does not decide
(a contract change, a priority call) is not demanded of them: propose it be raised with the side that
owns it, in the MR description. If a fix would reach wider than the comment, ask for the touched files
to be listed.

In the language the team writes its MRs in (the user's, unless told otherwise). The finding ids from the findings file stay in the comments — the
same `F-01` in the file, in the chat digest and on the forge.

One finding per comment, self-contained:

````markdown
**<Thesis in one line, bold.>**

<Analysis with evidence: run output or file:line.>

```ts
<fix>
```
````

<Optional: what is common to all N files.>

```

## 6. After publishing — read it back

Fetch the discussions again and confirm each thread exists, landed on the intended line, and that
non-ASCII text survived the round trip. A `201` proves the request was accepted, not that the comment is
readable where it was meant to be.

Then `node <kit>/tools/review-sync.mjs <report> --write` — it writes the `- **Thread:** <url>` line
of every published finding (what `published` counts) and recomputes the header; the same command
after the author's replies closes the loop ([handoff.md](handoff.md)). Every `unmatched ours` or
`tie` row it prints is a thread just posted that it could not pair — write that finding's `Thread`
line by hand now, while the mapping is known. Threads other reviewers opened before ours never enter
"Found by others"; one we answered in their thread does not either.

Report back with the MR link, the count posted, and the ids that stayed local (unpositionable ones).
Never resolve threads, never approve, never merge — those are the author's and the maintainer's.

Three numbers go into the findings file with the report: **raised · published · confirmed by the
author**. The gap between the first two is the review's own kill rate and is the most informative thing
it produces — a pass that drops four candidates under proof for three published is working correctly,
and one that has never dropped anything is not verifying. The third arrives later, from the threads,
and is what says whether the bar is set where the team can use it.
```
