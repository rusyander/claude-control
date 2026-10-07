# Mode C — Discovery (agent docs scattered outside the canonical roots)

Modes A/B assume the layout of `SKILL.md` §1. Real projects scatter docs: repo root, `docs/`, `notes/`, `ai/`, per-package `CLAUDE.md`, next to code. Run this when entering an unfamiliar project, when the user says docs are "everywhere", or when a sweep feels incomplete.

**Consent first** (`SKILL.md` §0): a project that already has its own layout gets a question before any migration, not a migration followed by a report.

## C1. Find candidates (metadata + name first, content only to confirm)

Look project-wide for `.md`/`.txt` outside `node_modules`/`dist`/`.git`, then classify. Strong agent-doc signals:

- Name: `PROGRESS`, `PLAN-*`, `TASKS-*`, `TZ-*`, `AUDIT*`, `NOTES`, `*-report`, `*-analysis`, `handoff`, `checklist`, dated filenames.
- Location: `.agent/`, `.claude/`, `ai/`, `notes/`, `tmp/`, repo root next to source.
- Content: checklists with status marks, phase/task IDs, "left / remaining", raw measurements, agent-written first person, commit SHAs as evidence.

Human-doc signals (LEAVE ALONE): `README`, `CHANGELOG`, `CONTRIBUTING`, `LICENSE`, `ONBOARDING`, ADRs, `docs/` written for the team, anything committed and referenced by humans, anything with prose intended to be read by a person.

Data-file signals (leave, never translate/compress — only split if unreadably large): tables of measurements, node-ids, hex, generated exports, spec dumps.

## C2. Verdict per file

| Verdict                                     | Action                                            |
| ------------------------------------------- | ------------------------------------------------- |
| Agent doc, live, outside canonical roots    | migrate → `<repo>/.agent/`, update any references |
| Second `CLAUDE.md`/`AGENTS.md` in a package | merge into the root one, delete the copy          |
| Agent doc, live, in place                   | apply Mode A budgets/language                     |
| Agent doc, stale/closed                     | → `.agent/archive/` + hook line in `ARCHIVE.md`   |
| Agent doc, dead artifact                    | delete (Tier 1 rules from Mode B)                 |
| Human doc                                   | leave untouched, whatever its language            |
| Data                                        | leave; split only if it blocks reading            |
| Unclear                                     | ASK — do not migrate or delete on a guess         |

## C3. Migration rules

- Git-tracked file → do NOT move silently: moving it is a repo change the user commits. List it and ask.
- Untracked agent doc → move freely into `.agent/`, keep the filename, report the move in one line.
- After moving, grep for references to the old path and fix them.
- Never move anything you did not conclude is an agent doc.

## C4. Where agent docs BELONG

Layout = `SKILL.md` §1, no exceptions invented here. Two traps:

- User asks for an agent doc "in the root" → they intend to READ it → it is a HUMAN doc: write it properly, in their language, where they asked. Not an agent doc, not `.agent/`.
- A location the user deliberately chose and wants kept → don't relocate silently; register it: `doc-policy-set.mjs <dir> keep <rel/root>`.
