# Before/after shots — a UI file is in hand

Auto-applies to any fix with a visible result, no reminder needed.

1. `.agent/screenshots/before-after/<task>/` — created BEFORE editing anything.
2. Analyse what is wrong and WHERE in code.
3. BEFORE shots via the browser QA-kit, named `<what>_BEFORE.png`.
4. Edit, then typecheck/lint.
5. **Dev server running (vite/HMR) → AFTER shots right away, no waiting.** Start it yourself.
6. Compare and verify. BEFORE no longer capturable → say so.
7. One folder per task + a short README.

Non-visual fixes skip the shots and keep "analyse → edit → verify". The user can waive them per task.

An anticipated MR is itself a reason to take BEFORE shots early; composing the MR body
(screenshots-vs-text question, embedded images, AFTER-only fallback) = skill `agentdeck-kit:changelog-builder` §3.
