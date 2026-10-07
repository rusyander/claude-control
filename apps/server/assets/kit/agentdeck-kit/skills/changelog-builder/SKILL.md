---
name: changelog-builder
description: "Use when asked for an MR/PR description, changelog or 'what changed' summary — paste-ready digest from diff + TASKS.md + chat."
---

# Change summary / MR description

## 1. Sources

1. Diff: `git diff <base>...HEAD --stat` plus the changes themselves (base per project convention;
   none recorded → `git merge-base HEAD <default-branch>`).
2. Root `TASKS.md` if `agentdeck-kit:task-spec-builder` kept one — task ids, symptoms, solutions, statuses. That
   is the skeleton of the description.
3. Conversation context: what was fixed, what was verified, known limits.
4. Target format: the project's MR convention. Look at past MRs (`glab`/`gh` if available) and
   `.gitlab/merge_request_templates` / `.github/`; otherwise the default below.

## 2. Default structure

Headings and text in the language the project's MRs use (else the user's); the English skeleton
names the parts:

```markdown
## What changed

- T1: <symptom> → <fix in one phrase> (`path/to/file`)

## How it was verified

- <live run / scripts / type-check; link to before-after shots, if any>

## Limits and risks

- <deliberately untouched / known limitations / rebuild of X needed>
```

- Write from the **actual diff**: no claim without a change, no change without a claim.
  Gate: every file in `git diff --stat` maps to a bullet; leftovers listed explicitly or claimed
  as noise.
- The same gate covers the header: every ticket id in the title and in the "Closes" line names the hunk that
  closes it; already solved on main → drop it or write "already on main since `<sha>`". Reviewers check this
  first and send back an id with nothing behind it in the diff.
- Every fact the text quotes — a mock node id, an endpoint or method list, a config key, a number, a
  UI string — is re-read from the code or spec on the pushed head, not from memory — recalled facts have
  shipped two node ids for one mock and a lint severity the config did not have.
- A limitation, follow-up or "backend-side limitation" carries its tracker id. No ticket yet →
  ask the user whether to file one; an unnumbered "in a separate ticket" is what reviewers send back.
- "How it was verified" names the commit it ran on; a later push makes it a claim about another tree.
- Group by meaning (features / fixes / refactor), never by file.
- Language: whatever the project's MRs use. Self-contained wording — the reader never saw the chat.
- No water: "fixed X when Y", not "improved stability".

## 3. Screenshots in the description — ask exactly once

Trigger: the change is **user-visible** AND the user asked to create a branch / add commits / write an
MR or its description. Before composing the body, one question to the user, in their language: "text only" vs
"text + before/after shots" (mark the second recommended). The answer holds for the whole task —
never re-ask per commit. "just do it" / "text only" = text-only with no question at all;
a non-visual change = no question, text-only.

Shots chosen → **embedded images, never local paths**: `.agent/screenshots/` is gitignored, so a path
is worthless to a reviewer. Upload each BEFORE/AFTER file through the forge (an MCP upload tool, else
`glab`/`gh` or the forge API under the user's own login), paste the returned markdown into
the body, before and after side by side per change.

A pair is comparable or it is not a pair: same route, viewport, data, theme and locale on both sides —
anything that differs besides the fix is named under the pair (else the review answer is "before/after shots do not match").

BEFORE not capturable — shots were skipped pre-edit, or the stand has already been rebuilt — → say so
in the description and offer AFTER-only. A re-staged BEFORE is a fabricated one. Anticipating an MR is
itself the reason to take BEFORE shots early, per the kit workspace rules.

## 4. Delivery

Summary into the chat for copying, and into the end of `TASKS.md` if the user wants it.
Conventional commits in use → offer the MR title in that format too.
Proposing the whole move — push, open the MR, edit an existing MR description — is on me unprompted;
each write still needs its own explicit yes per the forge protocol, and merging stays forbidden.

The description follows the branch: every later push → re-run the §2 gates against the new head and
offer the description update with the same yes. A description that outlived its branch is a review
finding of its own ("the branch has moved past its description — nothing to review").

## Red flags — run against the finished description

- A bullet with nothing behind it in the diff (invented) — header ids included.
- A change in the diff that landed in no bullet (lost).
- "How it was verified" written when no verification happened — honesty beats completeness.
- A known limitation with no ticket number; a quoted fact nobody re-read on the pushed head.
