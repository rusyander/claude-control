---
name: batch-runner
description: 'Use for a batch of same-shaped units across many files, migration sweeps — bounded-context worker per unit.'
---

# Batch runner — bounded-context sweep

Engine: `node <kit>/tools/skillstate/run.mjs <task-dir>` — one fresh `claude -p` worker per unit,
context O(1) in batch length (SKILL.state pattern, arXiv:2608.26263). Knowledge crosses units only
through validated state patches; full trajectories persist on disk in `trajectory.jsonl`.

## 1. Qualify — the gate that keeps this honest

Runner earns its place only when ALL hold:

- ≥8 homogeneous units (files/components/modules) under ONE written procedure;
- per-unit verification exists — a command or read-back check a worker can run itself;
- units are independent: order must not matter, no unit edits another unit's files.

Fewer units, heterogeneous work, or exploration → do it directly, no runner. Backend units → the
read-only rule binds workers too: the user's yes BEFORE scaffolding. Launching workers IS spawning
under the canon (`CLAUDE.md` → «Orchestration is opt-in»): it needs the user's own ask for THIS task
— a batch-shaped request in their words is exactly that, a hook's hint is not. No fleet size to name:
the loop is sequential, one worker at a time, depth 1 — workers never spawn.

## 2. Scaffold `.agent/tmp/batch/<slug>/`

Shapes in `<kit>/tools/skillstate/templates/` — copy and fill:

- `spec.template.md` → `spec.md` — the procedure P: task, per-unit steps, a verify step, conventions,
  out-of-scope. A worker sees NOTHING but spec + compact state + its unit — spell out real paths,
  commands, idiom.
- `state.template.json` → `state.json` — `units_pending` from a real enumeration (Glob/grep, never
  memory); empty `units_done/units_failed/decisions/conventions/blockers/notes`; one-line `task`.
- `config.example.json` → `config.json` — `repo` as an ABSOLUTE long path (8.3 short paths trip the
  worker's path guard: it answers `blocked` on the first write), `allowedTools` minimal for the
  procedure — **a verify step that runs a command needs `Bash` in that list**, `permissionMode`
  alone does not grant it — `gate` = the repo's real check (`type-check && lint` …), model default
  `claude-sonnet-5`, `effort` null (CLI default) — a mechanical procedure usually holds at `low`, and
  the §3 trial is where the cheapest model + effort pair that still gets the unit right is picked.
  Workers answer through `--json-schema`; one that stops without its answer is resumed up to
  `maxContinuations` (2) times before the attempt counts as invalid. `stateBudgetChars` (4000) caps Σ in the worker's prompt: over it the OLDEST
  `notes`/`conventions`/`decisions` drop out of the VIEW, `state.json` keeps them.

Done when: all three files exist and spec.md answers "could a stranger with zero context do one unit?"

## 3. Trial one unit, then launch

1. `node <kit>/tools/skillstate/run.mjs <task-dir> --one-unit` — one unit, foreground, and a
   REAL run: that unit's edits land in the repo. Inspect the diff it produced + the
   `trajectory.jsonl` tail. Wrong → fix `spec.md`, re-queue the unit (`--requeue-failed`), repeat
   until one unit comes out right.
2. Clean → full run in background (`run_in_background: true`), tell the user it launched (RU),
   continue other work.
3. On the completion notification read `result.json` + `state.json` — never guess mid-run progress.

Spend is **quota, not money**: a fresh worker per unit against the subscription's rate window, and
`est_cost_usd` is only the API price the CLI would have charged — quote it as an estimate or not at
all. A long sweep launched into an almost-spent window stalls mid-batch; resume is a plain rerun, so
that is a delay, not damage.

## 4. Close out

- `ok: true` **with `mode: "batch"`** → report RU: units done, gate output, notable
  `decisions/conventions`. `mode: "one-unit"` + ok:true says the trial landed and nothing more.
- Failed units → read their trajectory records, fix the cause (usually spec.md), rerun with
  `--requeue-failed`: it unwraps `{unit, status, attempts}` and puts the units back at the head of
  the queue. Moving them by hand means moving `.unit`, never the wrapper — the wrapper reaches a
  worker as garbage. Only a `done` unit's `decisions/conventions/notes` enter shared state; a failed
  one's patch is logged `patch_discarded` and kept in `trajectory.jsonl`, so a genuine insight from a
  failed attempt is carried over by hand. Its `blockers` always land — that is what blocked is for.
- `blockers` non-empty → surface them verbatim to the user before any rerun.
- Task-dir stays under `.agent/tmp/` (local, disposable). Workers are one-shot processes — nothing
  to kill.

Gate: `result.json` shows `ok: true`, `mode: "batch"`, and the repo gate ran green — only then report done.

## Red flags

- A spec.md that only makes sense with this conversation's context — the worker will flounder.
- `units_pending` typed from memory instead of enumerated from the tree.
- Runner used to "parallelize" heterogeneous work — that is plain orchestration, different rules.
- Per-task tweaks edited into `run.mjs` — task variance belongs in `spec.md`/`config.json`.
