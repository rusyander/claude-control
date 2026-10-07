---
name: project-audit
description: 'Use on a full/deep/hard audit of a repo — tools first: security, deps, cycles, complexity, duplication, stack canon → report files.'
---

# Project audit — evidence or it didn't happen

Whole-repo hard audit. The verdict comes from TOOLS plus verified findings, never from impressions.
Every claim carries `file:line` + why + fix + severity. The report pack is the deliverable — the user
fixes from it; the audit itself changes nothing (fixes are a separate, approved pass).

## Non-negotiables

- **Artifact or SKIPPED** — each dimension either ran its tool (raw output saved) or stands in the
  summary as SKIPPED with the reason (tool absent, offline, no code in scope). No silent gaps.
- **Stack canon** — judge each stack by ITS OWN canon (the `references/` playbooks): Go by Go idiom,
  React by React canon, Python by modern tooling. A pattern fine in one language is a finding in
  another; the playbook names which.
- **Verified severity** — every P1/P2 is re-proved against live code before it enters the report.
- Read-only zones from the project `CLAUDE.md` (e.g. `api-backends/`, `deploy/`) are still AUDITED
  (reading is free) but findings there are tagged `report-only` — their owners fix them.

## Phase 0 — scope & stack detection

Inventory every manifest: `package.json` (workspaces too), `go.mod`, `pyproject.toml`,
`requirements*.txt`, `angular.json`, Vue config. Map each to a playbook — `references/js-react.md`,
`references/go.md`, `references/python.md`, `references/angular-vue.md` — or exclude it with a reason
(generated, vendored, third-party snapshot).

**Gate:** a table `manifest → stack → playbook | excluded (why)` covering every manifest the glob
found. An unmapped manifest = the audit has a hole.

## Phase 1 — tool sweep

Exact commands, fallbacks and Windows quirks per ecosystem: `references/toolbelt.md` — open it for
the detected stacks, run every dimension, save RAW tool output into the report pack `artifacts/`:

1. Known vulnerabilities 2. Dependency cycles 3. Dead code + unused deps 4. Copy-paste duplication
2. Complexity hot-spots 6. Secrets in the tree 7. Licenses 8. Outdated majors 9. Type strictness

**Gate:** 9 dimensions → 9 artifact files or SKIPPED lines in SUMMARY. An empty artifact is written
as "clean run, 0 findings" — distinguishable from "never ran".

## Phase 2 — stack-canon review

Per detected stack, one pass per playbook area (components/state/effects/bundle/types for React;
concurrency/errors/interfaces/layout for Go; analogous splits in each playbook), run by me in
sequence, findings written straight to the report pack. Parallel subagents for the areas only on the
user's go-ahead for THIS audit, fleet size named by them (`CLAUDE.md` → orchestration) — each then
gets its playbook section, the file list in scope, the literal `[return-format]` and
`[no-subagents]`. A checklist item becomes a finding only with local `file:line` evidence.

**Gate:** every playbook section is either covered by a findings file or marked "no code in scope".

## Phase 3 — adversarial verify

For every P1/P2: open the cited file, confirm the quoted line exists and the claim survives context
(a config may neutralize it, the code may be dead, a guard may sit upstream). Confirmed → keep with
the quote. Not confirmed → drop, or downgrade with a note saying why.

**Gate:** 0 unverified P1/P2 in the final report.

## Phase 4 — report pack

`.agent/audit/<yyyy-mm-dd>/`, written for the USER (Russian), raw artifacts as data:

- `SUMMARY.md` — RU: verdict per dimension, counts table, top findings by severity, quick wins.
- `<dimension>.md` — RU, one per dimension: each finding = `file:line`, what, WHY it is a problem
  (name the violated practice), how to fix, severity, effort.
- `artifacts/` — raw tool outputs, untranslated.

Severity: **P1** correctness/security/data-loss · **P2** architecture/maintainability with a named
cost · **P3** polish. Effort: **S** <1h · **M** ~day · **L** multi-day.
On request: top findings → `TASKS.md` via `agentdeck-kit:task-spec-builder`; deep dives route to their own skills
(`agentdeck-kit:perf-audit`, `agentdeck-kit:a11y-audit`, `agentdeck-kit:i18n-audit`, `agentdeck-kit:improve-react`) instead of being re-done here.

## Red flags — post-hoc self-check

- A dimension with zero findings AND zero artifact — it did not run.
- A finding without `file:line` — an opinion, not a finding.
- A playbook item quoted as a finding with no local evidence attached.
- SUMMARY counts smaller than the union of the detail files — findings dropped silently.
