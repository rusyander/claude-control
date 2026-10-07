---
name: prototype
description: 'Use when a design or UX question needs running code to settle it — throwaway prototype: radically different UI variants on one route, or a tiny logic harness.'
---

# Prototype — code that answers one question, then dies

A prototype is an experiment, not an early version of the feature. Its output is a **decision**; the
code is the receipt and gets thrown away.

## 1. Name the question first

One question, written down before any code: "which of these three layouts survives a 40-item list?",
not "explore the settings page". If reading the existing code or asking the user answers it, do that
instead — a prototype is for questions only running code can settle.

## 2. Pick the branch

- **UI, layout, interaction** → every variant on ONE throwaway route (`/prototype/<slug>`), switched by
  a URL search param (`?v=2`) with a fixed floating bar listing the variants. One path, one build,
  comparison is a click.
- **Logic, data shape, API ergonomics** → a harness run by a single command (`node .agent/tmp/<slug>.mjs`
  or a scratch test file) that prints the state it produced.

Variants must differ **radically**. Three shades of one idea answer nothing. UI variants: give each a
**signature element** that carries the difference, and spend no variant slot on the three AI-default
looks (cream + high-contrast serif + terracotta; near-black + single acid accent; broadsheet hairlines

- dense columns) unless the brief asks — a template look answers nothing about _this_ design.

## 3. Rules while building

- Marked throwaway: first line `// PROTOTYPE — throwaway, delete after <question>`. Lives on the
  prototype route or in `.agent/tmp/`, never inside a real module.
- One command to run, no setup ritual.
- Fixtures only — hardcoded data or msw. Backend and DB stay read-only; a prototype never writes.
- Polish is skipped on purpose: no error handling, no tests, no i18n, no a11y pass, no responsive work.
- Surface the state — render or print what the code decided, so the answer is visible without a debugger.

## 4. Decide, capture, delete — same pass

1. Show the user: UI branch → a screenshot per variant in `.agent/screenshots/before-after/<task>/`,
   named by variant; logic branch → the printed output. Russian, one line per variant, recommendation
   attached.
2. The user picks. No winner, or a hybrid wanted → treat it as a new question: one more variant
   round, the hybrid built and shown as a variant of its own. Record the decision **and why the
   losers lost** in `.agent/notes.md` — hard to reverse plus surprising plus a real trade-off →
   ADR (skill `agentdeck-kit:doc-hygiene`); a new term settled → `.agent/glossary.md`.
3. Delete the prototype — its files under one dir, so that is one command; a delete outside agent
   zones asks the user first (`destructive-guard`). Gate: the route is gone, `.agent/tmp/<slug>` is gone, and
   `rg -n 'PROTOTYPE' --glob '!node_modules'` from the repo root returns nothing.
4. The real implementation starts from the decision, written fresh. Promoting prototype code ships
   every corner cut in step 3.

## Red flags — run against the finished prototype

- Prototype code promoted into the feature instead of rewritten.
- Variants differ only cosmetically, so the comparison proves nothing.
- Error handling, tests or polish inside a throwaway.
- The question was never written down, so nothing decides when it is done.
- It ran, and no decision was recorded anywhere durable.
- It is still in the tree when the task closes.
