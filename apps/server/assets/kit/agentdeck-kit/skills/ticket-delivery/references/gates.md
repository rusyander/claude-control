# Gates and pipeline — §6 once, in CI's image when needed, red blocks the push; §11 not read

## When the full gate runs (§6)

ONCE per task, on the final tree: after §9 and §10 are closed and committed, right before the §8
push. Everything earlier takes narrow checks (SKILL.md §Working discipline). The runner memoises per
tree, so a green run on an unchanged tree is reused, never repeated. It runs again only after an
edit; an edit made after the MR — a reviewer thread, a §11 conflict — re-runs only the touched
packages' checks, unless the edit reaches a shared config, lockfile or contract, which takes the full
gate again. Two full runs with no edit between them is a red flag (stages.md).

## A gate the local machine cannot run (§6)

It is REPRODUCED, not skipped — wrong runtime major, a missing interpreter, a toolchain that will not
build here. Rebuild CI's own job in its own image (`docker run --rm --label claude.ephemeral=1` on
the image and commands the CI config names) and say in the report that it ran there, not locally. A
gate recorded `skip` because the laptop lacks the runtime is an untested change wearing a green row.

The same holds for every piece: one only the LOCAL machine lacks is not a missing piece — reproduce it
in CI's image before calling it absent (§14, discovery.md §What degrades).

## A red gate blocks (§6)

Nothing is pushed or undrafted on a red row; local commits stay free. An escape (`Docs-Impact: none —
<reason>`, `Tests-Impact: none — …`) is an INPUT the gate reads: it goes into the commit message
first, the gate is re-run, and only its green verdict counts. «Red, escape planned» or «red,
explained in the MR» is still red — the gate reads the commit, not the reasoning.

## Pipeline (§11) — not read

The user reads CI themselves and reports a red job; a rerun is cheap. So: no read, no polling loop,
no `sleep`, no background watcher, no turn spent waiting — `11-pipeline skip "not read"`. A read
happens only when the user asks for one, and is then a snapshot: `created` / `pending` / `running` is
recorded as that state, and only `success` on the head sha may be called green or stamped
`11-pipeline ok`. The undraft and review move never wait on it (§12).

## Target branch (§11) — only a conflict moves the MR

The MR conflicts with the target → `fetch`, `rebase` onto it, the touched packages' checks, `push
--force-with-lease` to this ticket's own branch (git-guard treats the lease as an ordinary push; a
bare `--force` is refused). No conflict → the MR is not updated however far the trunk moved: the
user updates it on their own word — chasing the trunk re-runs the gate around the clock.

## Red jobs (§11) — when the user reports one

Classify every red job before saying anything about it:

- **my code or a skipped gate** → fix, the touched packages' checks (full gate if the cause is
  shared), push; never dismissed as flakiness;
- **the runner died** → retry once; a second infra death on the same job is reported, not retried
  (Stop and ask).

## A green pipeline is only as wide as its `rules:`

Before quoting it as evidence, read the CI config's conditions, not just the job list: a suite gated
on the trunk branch, on a `changes:` mask or on a manual trigger simply does not exist in this MR's
pipeline, so green says nothing about it. The report NAMES the gates CI did not run on this branch
and what covered them instead (usually §6 run locally or in CI's image).

Observed 22.09.2026: a repo whose Go and Python unit tests were `$CI_COMMIT_BRANCH == "main"` only —
every backend-only MR merged with its suite never executed, under a green pipeline.
