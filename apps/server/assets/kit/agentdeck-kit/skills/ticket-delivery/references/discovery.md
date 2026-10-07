# Discovery — what this project actually has

Detection first, never an assumption. Each piece is probed once, at the stage that needs it, and the
answer goes into the ledger so a resumed run does not probe again. A piece found absent degrades its
stage exactly as the table at the end of this file says, and is named in the report. **Absent infrastructure
downgrades the claim, not the verification standard** — what the environment cannot prove, the run
proves one level down, or declares unproven.

Probe order at §1, cheapest first: the project's own `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING`
(they usually name the tracker, the gates and the branch shape outright) → `package.json`,
`Makefile`, the CI config → the tool surface actually attached to this session.

## Tracker — §1 claim, §12 finish

1. **MCP** — the panel's tracker bridge `agentdeck-atlassian` (`jira_issue`, `jira_search`,
   `jira_comment`, `jira_create_issue`), else any `*jira*` / `*linear*` / `*asana*` server or the forge
   server's issue tools. A server still attaching is not an absent one; give it a moment before
   concluding. The bridge reads and comments but cannot assign or move a status: the claim is then
   a comment naming who took it, and the report says assignment and status stayed manual. Bridge
   answers "not connected" → say "not connected — connect it in Settings → Integrations" and go on
   as rule 4.
2. **Forge issues** — `gh issue view <n>`, or the GitLab MCP's `get_issue`. Claim =
   `gh issue edit <n> --add-assignee @me` plus the project's in-progress label or board column.
3. **A file in the repo** — `TASKS.md`, `TODO.md`, `.agent/TASKS.md`. Claim = a status edit on that
   line, committed WITH the work, never as a separate commit.
4. **None** — the handover message is the ticket.

The claim runs only where the tracker exposes both assignment and a status move. Exposing one half ⇒
do that half and say in the report which half was impossible. **A key held by somebody else stops
the run at §1 whatever the tracker is**: `stop` in the ledger, the reply names who holds it.

No tracker at all ⇒ §1 becomes: restate the scope from the user's words as checkable statements in
the ledger BEFORE the first edit, and treat that restatement as the ticket for §3, §10 and §12. The
ledger key is a slug (`login-empty-state`).

## Forge — §8 MR, §11 pipeline, §12 finish

`git remote -v` names the host; the tool that reaches it is, in order: the forge MCP for that host →
`gh` (GitHub, `gh auth status` to confirm) → `glab` → nothing. A REST call by hand is a fallback,
not an alternative: say the MCP is missing and get a yes before improvising.

Draft support: GitHub `gh pr create --draft`, GitLab `draft: true` on create. A forge without drafts
⇒ create it normally and say in the description that review has not started yet.

No forge ⇒ §8 is commit + push, and the MR description text is written into the ledger and repeated
in the report. No remote at all ⇒ the commit is the deliverable, and §11 and §12 are `skip`.

## Gates — §6

Discovered, never invented. Read, in this order, and take the FIRST that is authoritative:

- the project's own doc naming the pre-commit or pre-MR gate (`CLAUDE.md`, `CONTRIBUTING`);
- the CI config — `.gitlab-ci.yml`, `.github/workflows/*.yml`, `Jenkinsfile`. **What CI runs is the
  gate**; a local convenience script that runs less is not;
- `package.json` scripts (`lint`, `typecheck`/`type-check`, `test`, `test:ci`, `build`), `Makefile`
  targets, `tox.ini`, `pyproject.toml`, `go.mod` (`go build ./... && go test ./...`).

Record the exact command list in the ledger at §6 and run it through `gate-run.mjs`, which writes the
`06-gates` row from the real exit codes. Distinguish the **autofix** (`--fix`, `--write`, a `check`
script that repairs in place) from the **verdict** (the same tools in check mode, as CI runs them):
only the verdict counts. A gate that cannot start (missing binary, wrong runtime major) is red, not
green — `ticket-preflight.mjs` catches the runtime case before the claim.

No gate anywhere ⇒ `skip` naming what was searched for, and §9 and §10 carry the whole verification
weight; the report says so in plain words.

## Branch convention — §2

The project's written rule wins. Absent, infer from `git branch -r --sort=-committerdate | head -20`
and follow the dominant shape. Neither ⇒ `<type>-<KEY>/<slug>`; several keys comma-separated after
the single prefix (`fix-A-1,A-2/<slug>`); no ticket ⇒ `<type>/<slug>`. `<type>` is the
conventional-commit type of the work, `<slug>` latin lowercase with dashes.

## Stand — §4, §7, §10

How the app runs: `package.json` scripts (`dev`, `start`, `storybook`), `docker-compose.yml`, a
`scripts/` launcher, the project's README. Credentials come from the project's gitignored env file,
read through the harness that owns it — never printed, and **never retried after a failed login**,
which is how accounts get locked. A user rebuild does not exist: never wait for one.

No stand ⇒ §4 and §7 are `skip`, and §10 drops to the same standard at a lower level: call the
endpoint or the function directly, once correctly and once with a deliberately wrong input, and put
both in the acceptance table. A check that could not run is reported as not done, never as passed.

## Design source — probed only after a "yes" at §1

Not part of the automatic probe set. Searched for only once the §1 design question has been answered
yes (review.md §Design re-check): a Figma link or node id in the task, a mock attached to it, or a
design file named in the project docs, reached through the Figma MCP only. Without that yes the
design source is not searched for, not recorded in the ledger and not mentioned in the report.

## Docs surface — §5

A docs site or folder in the repo (`docs/`, `content/`, a docs package) plus any gate that guards it.
Where a doc page names a source of truth, grep every touched path against those pages before
finishing. Nothing to update ⇒ `Docs-Impact: none — <reason>` in the commit message, never silence.

## Test suite — §9

The runner from the gate list. Present ⇒ a defect fixed here gets a test that is red before the fix
and green after, proved with `mustfail.mjs`. Absent ⇒ write the test in whatever idiom exists, and
if there is none at all, say plainly that the fix carries no automated regression net and that the
§10 table is the only evidence.

## What degrades when a piece is missing

Named in the report, never silently skipped, never reported as done. A piece only the LOCAL machine
lacks is not missing — rebuild CI's job in its own image (gates.md) before calling it absent.

| Absent       | Degrades to                                           | Report states                          |
| ------------ | ----------------------------------------------------- | -------------------------------------- |
| ticket id    | §1 scope from the user's words; key is a slug         | no ticket, where the scope came from   |
| tracker      | §1 no claim, §12 no status move; QA steps into the MR | none found, where the QA steps went    |
| forge / MR   | §8 push only; MR and QA text into the ledger          | branch name, that no MR exists         |
| CI           | §11 `skip`; §6 is the only automated evidence         | which gates ran locally, none remotely |
| dev stand    | §4 §7 `skip`; §10 becomes endpoint plus a wrong input | nothing seen running, what replaced it |
| test suite   | §9 `mustfail` cannot run; §10 table is the net        | the fix has no regression test         |
| docs surface | §5 `Docs-Impact: none — <reason>` in the commit       | nothing — the commit carries it        |
| gates        | §6 `skip`; §9 and §10 carry the whole weight          | which gate commands were searched for  |
