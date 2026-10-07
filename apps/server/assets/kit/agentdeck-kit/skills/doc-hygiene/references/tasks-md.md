# TASKS.md — lifecycle

`TASKS.md` at repo root (from `agentdeck-kit:task-spec-builder`) is a HUMAN-facing spec: the user reviews it, copies tasks into the tracker, and rarely re-reads it afterwards. It is the one agent-adjacent file that stays in the user's language.

**It must stay small — it grows without bound otherwise, and a bloated one is both unreadable and expensive.**

- **Keep in `TASKS.md`: only CURRENT/open tasks.** That is what the user reviews and what I execute against.
- **A task delivered and accepted → out.** Move its block to `.agent/archive/TASKS-done-<YYYY-MM-DD>.md` (never auto-read) and leave one short line in `TASKS.md`'s "Done" section, or nothing at all. Never keep full closed specs inline.
- A project `CLAUDE.md` that defines its own TASKS.md lifecycle **overrides this file** (e.g. delete the entry outright, no archive copy).
- **Prune on touch:** whenever a task is finished, archive it in the same pass — don't wait for a cleanup day.
- **Never delete the file itself** — the user relies on it existing.
- **Never read it whole** if it is large: Grep the task, Read with offset/limit. `doc-size-guard` enforces this.
- Target ≤25 KB (own limit — human prose in Russian; `BUDGET.tasksMd`, alerted at session start). Over that means closed tasks were left inline — archive them.
