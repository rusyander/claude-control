---
name: doc-hygiene
description: 'Use when writing any agent-facing doc (CLAUDE.md, .agent/, memory, TASKS.md, glossary, project-profile) or a doc-guard hook fires — layout, budgets, lifecycle.'
---

# Doc hygiene — agent artifacts

Agent docs = model's working memory; no human reads them → facts-per-token, human readability
irrelevant — except that a rule keeps its reason (§2, two registers). Prune on touch. Modes: **A. Write** §1–4 · **B. Sweep** `references/sweep.md` ·
**C. Discovery** `references/discovery.md`.

## 0. Consent gate — before restructuring anything

`node <kit>/tools/doc-policy-set.mjs --list` → mode. Fresh project → strict, no asking. Project
with its own agent-doc layout → **ASK** first. Declined / "hands off" → `… <dir> off`, doc hooks go
silent there · keep one extra location → `… <dir> keep <rel/root>` · undo → `… <dir> strict`.
State lives in the kit state dir (`doc-hygiene.json`, outside every project): a hands-off project gets no write, not even a
marker. Content edits never need consent; **placement** does.

## 1. Layout — ONE set per repository, monorepo included

```
<repo>/CLAUDE.md   entry point (or AGENTS.md, one of the two), auto-loaded, ≤6 KB → .agent/
<repo>/.agent/     every other agent artifact  (.git/info/exclude, not .gitignore)
<repo>/.claude/    tool config (skills, agents, project-profile.md)
```

No second `CLAUDE.md`/`AGENTS.md` in a package, no `docs/ai`, no per-package `.agent/`, no notes
beside code. `agent-doc-location` denies a new file outside these roots, asks on an existing one;
kill-switch `CLAUDE_DOC_LAYOUT=0`.
`.agent/`: `PROGRESS.md` (checkpoint, global CLAUDE.md) ·
`notes.md` (gotchas, decisions, conventions) · `glossary.md` (domain vocabulary — see below) ·
`ARCHIVE.md` (the index, kept forever) + `archive/`
(never auto-read, erased at the dead threshold; an `ARCHIVE.md` line must stand alone — once the
file is gone it is the only trace) ·
`tmp/` (disposable, purged 7d) · `screenshots/before-after/<task>/`.
Naming inside `.agent/`: `<slug>.agent.md`, so the audience survives a copy or a commit. Fixed
exceptions (addressed by name; `FIXED_AGENT_NAMES`, doc-policy.mjs): `PROGRESS.md`, `notes.md`,
`ARCHIVE.md`, `TASKS.md`, `README.md`, `glossary.md`, all under `tmp/ archive/ backup/ screenshots/ .trash/`.
**Dead threshold: 14 days** (`TTL_D` in `hooks/lib/doc-policy.mjs`) for `.agent/` docs — untouched that long
and not durable (`notes.md`, `glossary.md`, `PROGRESS.md`, `project-profile.md`, conventions) → presumed
dead, retire it. Committed config (`CLAUDE.md`, `.claude/`) is never stale by age.

### `glossary.md` — the domain vocabulary

Durable (never retired by age). One agreed term replaces a describing sentence and stops names
drifting across code, tests, `TASKS.md` and MR bodies.

- **Glossary only.** Not a spec, not a scratchpad, not a home for implementation decisions. A term, one
  or two lines of meaning, and what it is deliberately _not_ where that has bitten before.
- **Lazy creation** — the file appears when the first term is worth fixing, not at onboarding.
- **Written inline, never batched.** A term settles during a conversation → record it right then.
- **Challenge against it.** A user term contradicting the entry, or one word doing three jobs
  ("account" = Customer or User?) → say so, ask which holds. Code contradicting a settled term →
  surface it, never quietly pick a side.
- **Consult before naming** anything: a module, a test, a ticket title, an MR heading.
- A decision that is **hard to reverse** _and_ **surprising without context** _and_ **the result of a
  real trade-off** is not a glossary entry — it is an ADR. Missing any of the three → skip the ADR.

## 2. Write rules — every line

- **English.** Russian only inside quotes, as data. New docs English from the first write; existing
  Russian ones converted when next edited — never mass-translate a folder.
- **One fact per line.** No intros, transitions, summaries, restatements.
- Cut articles, copulas, hedges: "currently", "we should", "note that", "as discussed".
- Symbols beat words: `→ = ≤ > ~ !`; `x → y` for cause/flow.
- Keep decisions, gotchas, paths, numbers, absolute dates (`2026-07-25`); cut the reasoning behind
  them unless the _why_ is what stops the decision being redone.
- **Two registers.** Facts and reference data (paths, commands, numbers, maps) compress hard.
  A **behavioural rule** — anything telling the model how to act — stays a plain sentence carrying
  its reason ("X, because Y"): the model generalises from the why, while a bare imperative gets
  over-applied, and prompt shorthand bleeds into the model's own replies. Incident ids and dates
  give no reason — keep the lesson in words, the id lives in git.
- Never restate code / git / CLAUDE.md. No file trees. Code block >3 lines → path + line range.
- Link, don't copy: relative path or `[[memory-name]]`. Superseded fact → **replace in place**,
  never "update: actually…". Headings ≤3 words, nesting ≤2; tables for reference data, prose for rules.

**Self-check:** line deletable without losing a fact → delete · narration → delete · shorter symbol
available → use it · Cyrillic outside quotes → translate · over budget → archive, then split.
Examples → `references/compression.md`.

## 2a. Ladder — cheapest action first

The cheapest token is the one never written. Never start at "compress":

1. **Delete / archive whole** — dead doc (closed task, superseded, referenced paths gone). Decide
   from name + `Grep "^#"` + mtime + git; **never read it to decide**. Cost ≈0, saves 100%.
2. **Merge** — two docs on one topic → one, keep the newer facts.
3. **Link** — content that already exists in code/git/another doc → pointer, delete the copy.
4. **Compress** §2 — only what survives 1–3 and is actually live.
5. **Split** — only when a live doc is still >15 KB after compression.

Ratio check on a compression pass: human-written agent prose should land **2–4×** smaller. Cut
<25% → the doc was already dense: stop, record the size, do not churn it again. Report `before → after`.

## 2b. Giant docs (>40 KB / >1000 lines) — the failure case this rule exists for

Big docs survive because every pass defers them. Deferring is not allowed twice.

- Never read whole (`doc-size-guard` denies it). Triage by metadata.
- Dead → whole file to `archive/` + one `ARCHIVE.md` line. Done, nothing read.
- Live → split by topic into ≤15 KB files **this session**, or write an explicit task into
  `.agent/PROGRESS.md` with the path and the size.
- Generated data (measurements, exports, node-ids) → neither compress nor translate; split only if
  size blocks reading.

## 3. Budgets

| Size    | Action                                               |
| ------- | ---------------------------------------------------- |
| ≤8 KB   | fine                                                 |
| 8–15 KB | prune closed items or split                          |
| >15 KB  | act now: archive → compress → split                  |
| >30 KB  | never read whole: Grep anchor → Read offset/limit    |
| >40 KB  | split; compressing mid-task costs more than it saves |

Covers `.agent/*.md`, `project-profile.md`, memory, kept audits (`TASKS.md` → own limit,
`references/tasks-md.md`); `CLAUDE.md`, loaded every turn, keeps the tighter ≤6 KB of §1. Enforced by `doc-bloat-guard` + `doc-size-guard`; mirrored in
`hooks/lib/doc-policy.mjs` `BUDGET` — change both or neither. Own skills: `SKILL.md` ≤8 KB, ≤12 KB as
an index over ≥3 `references/` (≤12 KB each) — canon `tools/skills-audit.mjs`, skill `agentdeck-kit:skill-authoring` §7.

`doc-bloat-guard` warns once per size plateau; a repeat means the file GREW, and silence is not
approval — the daily revision still lists it.

## 4. Daily revision — mandatory, once per day

`doc-daily-review` fires at session start (and on the first agent-doc write) with an inventory:
oversized / still-Russian / tmp / old screenshots. An order, not a suggestion: one short pass, then
back to the task. Closed → `archive/` + one `ARCHIVE.md` line · live >15 KB → compress per §2 · 1–2
largest Russian docs → translate, incremental only — all three without asking. Long-untouched and
spent → propose deletion as a **list**; deleting knowledge needs consent. Report ≤2 lines, Russian.

Sorting a whole project at once (agent + human) = skill `agentdeck-kit:docs-triage`, on request only.
Mechanical check any time: `node <kit>/tools/docs-validate.mjs` — honours §0 (`off` → no
placement/language advice; secrets, sizes, links still reported).

## References

`compression.md` examples · `sweep.md` Mode B inventory, staleness, three-tier delete/archive/ask —
read BEFORE any deletion pass · `discovery.md` Mode C migration · `tasks-md.md` TASKS.md lifecycle.
