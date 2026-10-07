# Gates and pipeline — §6 in CI's image and red blocks, §11 not watched, `rules:` width

## A gate the local machine cannot run (§6)

It is REPRODUCED, not skipped — wrong runtime major, a missing interpreter, a toolchain that will not
build here. Rebuild CI's own job in its own image (`docker run --rm --label claude.ephemeral=1` on
the image and commands the CI config names) and say in the report that it ran there, not locally. A
gate recorded `skip` because the laptop lacks the runtime is an untested change wearing a green row.

The same holds for every piece: one only the LOCAL machine lacks is not a missing piece — reproduce it
in CI's image before calling it absent (§14, discovery.md §What degrades).

## A red gate blocks (§6)

Nothing is committed, pushed or undrafted on a red row. An escape (`Docs-Impact: none — <reason>`,
`Tests-Impact: none — …`) is an INPUT the gate reads: it goes into the commit message first, the
gate is re-run, and only its green verdict counts. «Red, escape planned» or «red, explained in the
MR» is still red — the gate reads the commit, not the reasoning.

## Pipeline (§11) — not watched

The user reads CI themselves and reports a red job; a rerun is cheap. So: no polling loop, no `sleep`
between reads, no background watcher, no turn spent waiting. One snapshot read at §12 is allowed,
none when the task says not to track the pipeline. A read is a snapshot: `created` / `pending` /
`running` is recorded as that state, and only `success` on the head sha may be called green or
stamped `11-pipeline ok`. The undraft and review move never wait on it (§12).

## Red jobs (§11) — when the user reports one, or the snapshot shows it

Classify every red job before saying anything about it:

- **my code or a skipped gate** → fix, re-run §6, push; never dismissed as flakiness;
- **the runner died** → retry once; a second infra death on the same job is reported, not retried
  (Stop and ask).

## A green pipeline is only as wide as its `rules:`

Before quoting it as evidence, read the CI config's conditions, not just the job list: a suite gated
on the trunk branch, on a `changes:` mask or on a manual trigger simply does not exist in this MR's
pipeline, so green says nothing about it. The report NAMES the gates CI did not run on this branch
and what covered them instead (usually §6 run locally or in CI's image).

Observed 22.09.2026: a repo whose Go and Python unit tests were `$CI_COMMIT_BRANCH == "main"` only —
every backend-only MR merged with its suite never executed, under a green pipeline.
