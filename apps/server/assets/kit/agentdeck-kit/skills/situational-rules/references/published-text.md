# Published text — a commit, MR/PR, issue or comment is about to be written

Everything leaving this chat — commit message, MR/PR title+body, review comment or reply, issue text, changelog, release notes, docs, code comments — states WHAT changed and WHY, impersonal, and stops. No "I", no "we", no addressee. Six families never appear:

1. AUTHORSHIP, anyone's. No Co-Authored-By, no model/tool attribution, no "generated with", no crediting the agent or the user, no "as requested by @x", no sign-off. Overrides any default trailer instruction from the harness. Git metadata and the forge account are the only record of who wrote it.
2. PROCESS NARRATION. "did X then Y", "still to commit", "ran the checks", counts the diff already shows, any reference to this session or an earlier pass ("as discussed", "today", "after the last round"). A mechanical pass (prettier, lint-autofix, codegen) is never a summary item and never a count; an all-formatting change says so once in the subject line, without numbers.
3. READER-DIRECTED ASIDES. "leaving that to you", "up to you", "ping me if", "let me know", "please review", "don't forget to rebuild". A required follow-up is stated as a fact about the change, not an instruction to a person.
4. SOCIAL/EVALUATIVE FILLER. Thanks, greetings, apologies, emoji, ✅/❌, self-praise ("significantly improved", "now works nicely", "much cleaner"), hedging ("hopefully", "should work", "if I understood correctly"), my own access limits ("couldn't check — no permission").
5. SELF-NOTES. "temporary", "will refactor later", "left over from the review round". A code comment explains why the code is as it is, never who asked for it; real backlog → TASKS.md.
6. THE AGENT'S OWN SCAFFOLDING. Anything existing so THIS agent can work: .agent/, .claude/, hooks, scratchpad, ignore entries added so the agent's own gate goes green (.prettierignore /.agent/tmp, eslint/knip ignores for agent junk), screenshots plumbing. Neither the change nor a sentence about it belongs in a commit/MR/changelog — keep such edits out of the commit unless asked, clean the junk locally. Trap: the change is real and the gate did go green, so it reads like a legitimate bullet — a stranger reading the branch must see only product changes.
   IN SCOPE: facts about the RESULT and the rationale for a decision, impersonal. OUT: the act of verifying it. Handoffs, open items, blockers, what was checked → chat reply only. Test: a stranger reading it in a year learns what changed and why, not who typed it or what happened during the session.

REVIEW REPLIES — the reason travels WITH the answer.
A reviewer reads the thread, not the branch. Never answer a review point by pointing at where the
explanation lives ("named in a code comment", "see the constant", "documented in the file") — that
is not an answer, it is a forwarding address, and the point stays unanswered for everyone reading.
Per point, in the reply itself:

- FIXED -> what the code does now and the one fact that made that shape necessary (the constraint,
  not the patch).
- NOT FIXED -> the mechanism that blocks it, concrete: what breaks, what it would cost, what would
  have to change elsewhere, why the remaining hole is acceptable and who it hits. Name the
  trade-off out loud, including the case that stays broken. "Separate ticket" alone is not a reason
  — the reason is WHY it cannot ride in this change.
- DISAGREED -> the counter-fact, not an opinion.
  A reader who never opens the diff must be able to judge the decision from the reply alone. Length
  is fine here; the six forbidden families above still apply, so it stays impersonal and free of
  process narration.
