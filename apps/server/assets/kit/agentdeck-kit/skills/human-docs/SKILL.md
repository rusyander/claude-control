---
name: human-docs
description: 'Write or consolidate human docs — README, docs/, guides, ADR.'
disable-model-invocation: true
---

# Human docs — documentation for people

Written for a person, committed to the repo, **in the language the project's docs already use**
(none yet → the user's language) — a second language only when the user asked for one (then both
versions stay in sync, e.g. `X.md` + `X.<lang>.md`). The opposite audience
from `agentdeck-kit:doc-hygiene` (English, agent-only, auto-enforced). Never touch both in one pass.

## 0. Mode — pick before doing anything

| User says                                                              | Mode                               | Meaning                                             |
| ---------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| "gather / group / clean up the docs", "put the docs in order"          | **CONSOLIDATE**                    | existing docs → one tree, deduped, outdated removed |
| "write documentation for the project", "document X", README/ONBOARDING | **AUTHOR**                         | write from scratch off the code                     |
| both, or unclear                                                       | ask **one** question, then proceed |

Mixed reality (some docs exist, mostly wrong) → CONSOLIDATE first, AUTHOR the gaps it exposes.
Details: `references/consolidate.md`, `references/author.md`. Style is shared: `references/style.md`.

## 1. Freshness — the code is the only source of truth

Documentation lies by default: it was written once and the code moved. Nothing carries over on
trust — the global cache-is-a-hint rule applies to every source, including this pass's own notes.

- Every factual claim (command, path, port, env var, flag, version, API shape, default) is
  **re-verified against live source**: read the file, run the command, check `package.json`.
- Cannot verify a claim → **delete it**. Never copy an unverifiable sentence into the new doc.
- Doc and code disagree → code wins, silently, and the doc line is rewritten.
- Verify at write time, not from an inventory built earlier in the pass — a long pass goes stale
  inside itself.

## 2. Layout — ONE documentation tree per repository, monorepo included

```
<repo>/README.md   entry point: what it is · quick start that actually runs · links onward
<repo>/docs/       every other human doc; ≤2 nesting levels
<repo>/docs/adr/   decisions, one file each, dated, never rewritten after acceptance
<repo>/CHANGELOG.md  releases only — never a "history" section inside a doc
```

`README.md` **stays in the repo root** — the human mirror of CLAUDE.md, an entry point, never moved
into `docs/`. The root also keeps `CHANGELOG`, `CONTRIBUTING`, `LICENSE`, `SECURITY`,
`CODE_OF_CONDUCT`, `TASKS.md` — GitHub and tooling look for those by exact path; every other human
doc goes to `docs/`. No per-package `docs/`, no second wiki beside
code, no duplicated README content. In a monorepo a package `README.md` is allowed **only** as a
≤5-line stub: what the package is + link into `docs/` — unless the package is consumed outside the
repo (published to npm/Maven/PyPI, or handed to external integrators): then its README is the
package's public page and stays full. This section is the single layout
authority — `agentdeck-kit:docs-triage` placement follows it.
Project already has an established different layout → **ask** before restructuring; keep theirs if
they say so, apply everything else.

## 3. Deletion policy — strict, this is the point of the skill

**Delete outright** (working copy, no asking): duplicate of another doc · superseded version
(`*-old`, `*-v1`, `copy`, `draft` in any language, `backup`, dated copies) · content contradicted by the code ·
empty or stub-only files · generated leftovers · anything untouched >14 days that the code proves
wrong. Deleting is preferred over marking "outdated" — a warning banner still costs a read.

**Ask first**: a doc a person clearly authored that is still correct but you would restructure ·
anything outside the repo · `LICENSE`, legal or compliance text · anything you cannot prove is dead.

**Never**: delete `LICENSE` · rewrite an accepted ADR (supersede with a new one) · commit anything.
All deletions happen in the working copy and are reported as a list — the user commits.

## 4. Writing rules — precise, no water

The doc language from the rule above. Identifiers, commands, paths, error strings stay verbatim.
Read `references/style.md` before writing the first line — full rules and the banned-phrase list. The core:

- Every doc opens with one sentence: **for whom + which problem**.
- One idea per paragraph, ≤3 sentences. No preamble, no "this document describes", no restating headings.
- Exact over vague: real commands, real paths, real versions, absolute dates (`2026-07-25`).
- A fact lives in exactly ONE doc; everywhere else a link. Duplication is the failure mode this
  skill exists to remove.
- No history, no "it used to be", no roadmap promises. Git holds history; `CHANGELOG.md` holds releases.
- Target ≤10 KB per doc; >40 KB → split by topic. The limit is a reader's patience, not a token
  budget — nothing human is auto-loaded — but a doc nobody can finish reading is not documentation.
- Don't document what the code says better — link to it.
- **Order sections by dependency, not by importance.** Information is a directed graph: a term the
  reader needs in section 3 must be grounded in section 1 or 2. A doc that explains something after
  first leaning on it reads as clear to its author and as noise to everyone else.

Human docs never carry a suffix — that absence is what distinguishes them from `*.agent.md`.
Sorting a whole project at once (agent + human halves) = skill `agentdeck-kit:docs-triage`.

## 5. Validate before reporting

```bash
node <kit>/tools/docs-validate.mjs
```

Layout, naming, language, sizes, dead links, duplicates, empty stubs, secrets — all mechanical,
zero tokens. Exit 1 = unresolved violations. Never report a docs pass as finished without it.

## 6. Report — in the user's language, compact

Table: `before → after` per file, plus counts (merged / deleted / created / left alone). Then the
list needing a decision, with the reason. State plainly what was verified by running and what was
not. Full detail → `.agent/tmp/docs-pass-<date>.md`, never into chat.
