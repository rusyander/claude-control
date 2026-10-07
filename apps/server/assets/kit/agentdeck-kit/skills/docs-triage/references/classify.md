# Classification signals

Decide from cheap evidence first: filename, path, headings. Open the file only when those disagree,
and then read the first ~40 lines, not the whole thing.

## Agent-facing

- **Name**: `CLAUDE.md`, `AGENTS.md`, `*.agent.md`, `PROGRESS`, `PLAN-*`, `TZ-*`, `AUDIT*`,
  `*-report`, `*-analysis`, `handoff`, `checklist`, `notes`, dated task files.
- **Location**: `.agent/`, `.claude/`, `ai/`, `notes/`, `tmp/`, `docs/ai|agent|claude/`, or beside
  source with no reader but the model.
- **Content**: status marks and phase IDs, "left / remaining", raw measurements, commit SHAs as
  evidence, first-person agent narration, instructions addressed to a model, token/context talk.

## Human-facing

- **Name**: `README`, `CHANGELOG`, `CONTRIBUTING`, `LICENSE`, `SECURITY`, `CODE_OF_CONDUCT`,
  `ONBOARDING`, `TASKS.md`, ADR files, guide/tutorial/howto names.
- **Location**: repo root (the conventional set), `docs/`, a docs site source tree.
- **Content**: prose written to a person, screenshots, "you", onboarding steps, product
  rationale, anything a reviewer or newcomer is expected to read.

## Data — leave alone

Tables of measurements, node-ids, hex, generated exports, spec dumps, fixtures. Never renamed,
never translated, never compressed. Split only if size blocks reading.

## Conflicts — how to break a tie

| Situation                               | Verdict                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Agent-shaped content sitting in `docs/` | agent → move, **unless** it is git-tracked and referenced by a human doc → ask |
| Human-shaped prose inside `.agent/`     | human → move to `docs/`, drop the `.agent` suffix                              |
| `TASKS.md` at the root                  | human, always — user's language, stays at root                                 |
| Russian prose in an agent location      | still agent: language is a defect to fix, not a classification                 |
| English prose in `docs/`                | still human: language is a project choice, not a verdict                       |
| Written by the user themselves          | human unless it plainly instructs a model                                      |
| Genuinely unclear after 40 lines        | **ask** — never guess                                                          |

## Renaming

Agent: `<slug>.agent.md`, slug in `kebab-case`, English, ≤4 words, describing the subject rather
than the occasion (`mcp-oauth.agent.md`, not `phase-3-report.agent.md`). Keep the fixed names listed
in `SKILL.md` §3 exactly as they are.

Human: `<slug>.md`, no suffix, name matching how a person would search for it (`deploy.md`,
`troubleshooting.md`). Never encode dates or versions in a human doc's name — git holds that.
