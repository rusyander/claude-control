# Profile — design (screens from a Figma mock)

Changes only what it names; order, ledger, authorisations, the one gate and Stop-and-ask stay
SKILL.md's. The parity method is `agentdeck-kit:figma-parity`, invoked, never restated. Picked at §3
when the ticket hands over a mock (profiles.md), or pinned by a panel group.

## Fits

The deliverable IS screens matching a mock: a Figma link or node in the ticket, a request to match
the mock one to one. A bug fix that only touches a screen is the frontend profile; its design
re-check stays the §1 question of review.md §Design re-check.

## Per stage — the deltas

- **§1** the one fork question is figma-parity's intake (mode, scale policy, target width —
  figma-parity references/intake.md), asked together with any other. Figma MCP not attached → say so,
  stop.
- **§3** one unit = one logical page of the mock; each page's statements are its states (empty,
  filled, error, loading, modal) — the §10 rows. Parity runs both ways: everything the mock shows is
  built, and nothing changed that the mock does not show.
- **§4** BEFORE per existing page; a new page has none, the report says «new».
- **§5** page by page. The orchestrator alone pulls Figma, once per node, into the cache
  (figma-parity references/figma-access.md). After the first page is built, spawn ONE checker
  (lane-high, model no weaker than yours) and keep it to the end; send each finished page as a
  message and move on without waiting. The checker reads the cache, compares the live page by numbers
  (figma-parity Phases 2–4), writes `.agent/parity/<page>.md`, fixes page-local drift and hands back
  shared-component drift, which you fix between pages. Values 1–2 px off the project scale snap to it
  (spacing 8/12/16, type 14/16, radius in numeric px); larger gaps are ESCALATE, never silent.
- **§9** markup/style-only diff: the checker's reports ARE the review — `09-review ok "parity
checker: N pages, 0 open"`. Any behaviour-bearing file → the one §9 `deep-review` over those files.
- **§10 + §7** figma-parity Phase 3 per page (states, hover, focus, the target widths) + one negative
  (error or empty state) per page; AFTER shots in the same walk.
- **§8** the MR description follows `agentdeck-kit:mr-visual-report`: a «For QA» block on top (where,
  steps, test data, no secrets), before/after pairs for changed pages, shots of every new page and
  state.

## Cut vs the universal flow, and why

- per-page review agents — one checker covers the visual axis; a second reader of the same numbers
  finds nothing new;
- the backend checklist — a mock carries no server change (one appears → fullstack).

## Loads

Skills: `agentdeck-kit:figma-parity`, `agentdeck-kit:mr-visual-report`,
`agentdeck-kit:style-conformance-review`, `agentdeck-kit:frontend-architecture` (if bound). MCP: the
official Figma MCP only (never REST or a wrapper), forge, tracker, a browser.

## Limits

One checker at a time, never more; it stops when the last page's report has 0 open. One Figma pull
per node per run — a repeat pull is a bug (rate limit).
