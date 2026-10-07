# Git / forge write — a mutating command is about to run

- ONE op at a time, each confirmed. `git-guard` refuses (an `ask` is dropped in permissive modes) until
  the user's words open a door: A) this turn's message names the op (voice-typing misspellings count);
  B) a reply after a refusal; B′) your last message named the op and asked, and the reply carries a
  yes; D) a question-tool answer (this turn, or a panel card pick as the next message) names or
  approves it. A bare repeat opens nothing. So ask FIRST, naming the command.
- "All git operations" = commit, push (non-force), rebase, checkout -b, switch -c, cherry-pick, revert,
  this turn. Force-push / reset --hard / branch -D / tag / stash drop / DROP-TRUNCATE / kubectl delete
  need an answer (B/B′/D), never door A. **Merge has no door**: the merge is the user's to run.
- `destructive-consent` + `secret-guard` share the gate. Any delete of real files asks, flags
  irrelevant; free only in agent zones (system temp, the session scratchpad, `mktemp`, `<repo>/.agent/`,
  the kit state dir) and regenerable caches (`node_modules`, `.vite`, `.vitest`, `.gradle`,
  `__pycache__`, a `coverage` dir holding coverage output) — so probes go to the scratchpad or
  `<repo>/.agent/tmp/`. Own split worktree also: untracked files this session wrote,
  `checkout <rev> -- <file>`, `restore <file>`.
- Default flow: changes stay in the working copy and the user decides what gets committed.
- GitHub/GitLab CLI/API writes (MR/PR, pipelines, issues): say what you are about to do, get a yes,
  each time.
- **Door C, the ticket grant**: while a ticket run is live (its ledger written by this session through
  `agentdeck-kit:ticket-delivery`) and the user's words in this window carry its tracker key
  (`PROJ-123`) or issue link, `commit`, `push` (never to the default branch), `checkout -b`, `rebase`,
  `cherry-pick` pass unasked; MR/tracker writes of that ticket too. **C′**: in a split worktree
  (`<repo>-worktrees/<dir>`) on a branch named after a tracker key, `commit`, `cherry-pick`, `rebase`
  and `push` (`--force-with-lease` included) to THAT branch pass unasked. Merge, `--force`/`+ref`,
  branch -D, reset --hard, tag, stash drop keep their doors.
- **Tracker link = the MR, never the branch.** Anything attached to a tracker issue (remote link,
  comment, description) points at the MR/PR: the branch is deleted on merge and its URL rots. Same
  wherever a reference must outlive the work.
