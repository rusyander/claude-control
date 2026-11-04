# Before/after shots — a UI file is in hand

Auto-applies to any fix with a visible result, no reminder needed.

1. `.agent/screenshots/before-after/<task>/` — created BEFORE editing anything.
2. Analyse what is wrong and WHERE in code.
3. BEFORE shots via the browser QA-kit, named `<what>_BEFORE.png`.
4. Edit, then typecheck/lint.
5. **Dev server running (vite/HMR) → AFTER shots right away, no waiting.** Start it yourself.
6. Compare and verify. BEFORE missed → the base-commit tree below; only when that cannot run, say so.
7. One folder per task + a short README.

**Which tree** (live 25.10: BEFORE from the user's main checkout came out blank twice, its cache
landed in that tree):

- Dev servers, builds and shot scripts run from YOUR working copy only — never the user's main
  checkout or another worktree: not your branch's base, not yours to write.
- BEFORE = your copy before the first edit. First edit already landed with no BEFORE → shoot it from
  the base commit in an isolated tree inside your copy:
  `mkdir -p .agent/tmp/base && git archive $(git merge-base HEAD origin/<target>) | tar -x -C .agent/tmp/base`
  (or `git worktree add --detach .agent/tmp/base <merge-base>`), install and build its local packages
  there, run its dev server on another port, stop it by its PID when the shots are taken.
- A blank or wrong shot of your own is retired, not deleted: `mv <shot> .agent/archive/<YYYY-MM-DD>-<task>/`
  (archive instead of delete), never `rm`.

**Shoot once, scoped to the change** (measured: 429 MR uploads in 3 days, one session 142):

- Shots = the screens/states the change touches, one BEFORE|AFTER pair each — not a tour of every
  screen; a wider sweep stays in the folder, never in the MR.
- A later fix (review, live run) re-shoots ONLY the screens whose code it touched; the rest stand.
- Each file uploaded once; the README keeps `file → URL`, an MR edit reuses those URLs.

Non-visual fixes skip the shots and keep "analyse → edit → verify". The user can waive them per task.

An anticipated MR is itself a reason to take BEFORE shots early; composing the MR body
(screenshots-vs-text question, embedded images, AFTER-only fallback) = skill `agentdeck-kit:changelog-builder` §3.
