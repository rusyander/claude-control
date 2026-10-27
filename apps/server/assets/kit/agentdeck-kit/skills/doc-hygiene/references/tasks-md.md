# TASKS.md — lifecycle

`TASKS.md` (from `agentdeck-kit:task-spec-builder`, or the task ledger) is a HUMAN-facing list: the user reviews it, copies tasks into the tracker, and tracks what was chosen and what is finished. It is the one agent-adjacent file that stays in the user's language. It is also the enforced task ledger: every task accepted or given is a line, every finished item `[x]` — the `task-ledger` Stop gate checks it; location, format and the single-writer rule → skill `agentdeck-kit:situational-rules`, reference `task-ledger.md`.

**It must stay small — it grows without bound otherwise, and a bloated one is both unreadable and expensive.**

- **Keep in `TASKS.md`: only CURRENT/open tasks.** Inside an open task its finished items stay, marked `[x]` — that is how the user sees progress.
- **A task whose items are all `[x]` (finished and verified) → out, in the same pass.** Move its block to `.agent/archive/TASKS-done-<YYYY-MM-DD>.md` (never auto-read) and leave one short line in a "Done" section, or nothing at all. Never keep full closed specs inline.
- A project `CLAUDE.md` that defines its own TASKS.md lifecycle **overrides this file** (e.g. delete the entry outright, no archive copy) — the marking of finished items stays.
- **Never delete the file itself** — the user relies on it existing.
- **Never read it whole** if it is large: Grep the task, Read with offset/limit. `doc-size-guard` enforces this.
- Target ≤25 KB (own limit — human prose in Russian; `BUDGET.tasksMd`, alerted at session start). Over that means closed tasks were left inline — archive them.
