---
name: a11y-audit
description: 'Use when asked for a UI accessibility audit (a11y, keyboard nav, contrast, aria) — axe-core + keyboard sweep.'
---

# Accessibility audit (a11y)

## 1. Scope & tools

Target pages/components: from the user, or the key flows (login, main screens).
Live stand + Playwright (project kit if there is one). Stand sick → skill `agentdeck-kit:stand-doctor` first;
login required → project auth memory before scanning. Autoscan: `@axe-core/playwright` — project
lacks it → throwaway package in `.agent/tmp/a11y/` with its own `package.json`; the project
manifest stays untouched.

## 2. Four checks — all four, always

1. **axe-core autoscan** per target page, both themes if a dark one exists. critical/serious first.
   Gate: `node .agent/tmp/a11y/scan.mjs <url>` (or the project kit's runner) writes
   `.agent/tmp/a11y/<page>.json` per page; the report table cites rule ids from those files.
2. **Keyboard**: Playwright sweep — `page.keyboard.press('Tab')` in a loop, after each stop snapshot
   `document.activeElement` (tag, text/aria-label, focus visible?) → focus-order list per page into
   `.agent/tmp/a11y/<page>.focus.json`. Judge from the artifact: order logical? focus visible? no
   traps? modals and dropdowns close on Escape and return focus to the trigger? every interactive
   element usable via Enter/Space? "Visible" is judged on a screenshot of the focused element, not
   its computed style: an `overflow: hidden` ancestor clips an outer ring the DOM reports as present —
   fix with an inset ring (`outline-offset: -2px` / inset box-shadow), not by dropping the overflow
   (a real widget regression).
3. **Semantics**: `button`, not `div onClick` · every field labelled · icon buttons carry
   `aria-label` · heading hierarchy intact · meaningful images have `alt`.
4. **Contrast**: axe catches most. By hand: states (placeholder, disabled, hover) in both themes.

## 3. Report & fixes

- Table: page → violation → impact → element → proposal.
- Split centrally-fixable (UI kit / design tokens — one fix covers every screen) from one-off.
- Contrast fixes go through theme tokens — central by construction.
- Fixes only with the user's approval; then re-scan the same pages and put the before/after
  violation count in the report.
- Visible UI change → before/after screenshots per the global rule.

## Red flags — run against the finished audit

- Report built on the autoscan alone: axe sees neither focus order, nor traps, nor meaningful
  markup — the keyboard sweep artifacts must exist per page.
- Blanket `aria-*` with no understanding: a wrong aria is worse than none.
