# Doc placement — a Markdown file is about to be written

Audience decides, not file type: a doc the user will not read is an agent doc.

## Agent-facing (profile, code maps, audits, notes, reports)

ONE set per repository, monorepo included: `<repo>/CLAUDE.md` (or `AGENTS.md`) + `<repo>/.agent/` +
`<repo>/.claude/`. No second instruction file in a package, no `docs/ai`, no notes beside code — found
elsewhere → migrate; git-tracked → ask first. Compressed English, named `<slug>.agent.md`, pruned on
touch. Layout, budgets, compression, daily revision, 14-day death, consent, `.agent/glossary.md` =
skill `agentdeck-kit:doc-hygiene`; `agent-doc-location` + `doc-bloat-guard` enforce placement and size.
`.agent/` is listed in `.git/info/exclude` (not `.gitignore`) — local, never in git.

## Human-facing (README, ONBOARDING, ADR, API docs)

`README.md` in the repo root, everything else under `<repo>/docs/` — one tree per repo. Never a
suffix: that absence marks the audience. In the user's language by default, a second language only if
asked (keep the pair in sync). No water; the user commits. Skill `agentdeck-kit:human-docs`, on
explicit request.

## Edge calls

- An agent doc requested in the repo ROOT = the user wants to READ it → human doc, their language,
  where they asked for it.
- Unsure → agent/local, or ask.
- Project with its own layout → ASK before restructuring. "Hands off" →
  `node <kit>/tools/doc-policy-set.mjs <dir> off`.
- `TASKS.md` is human-facing and holds ONLY open tasks — delivered → `.agent/archive/TASKS-done-<date>.md`
  in the same pass. Never delete the file, never read it whole.
- Whole-project sort = skill `agentdeck-kit:docs-triage` (on request). Mechanical check any time:
  `node <kit>/tools/docs-validate.mjs`.
