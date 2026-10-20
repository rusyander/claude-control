# Profile — backend

Changes only what it names; order, ledger, authorisations, the one gate, the MR and Stop-and-ask stay
SKILL.md's. Picked at §3 (profiles.md) or pinned by a panel group.

## Fits, and when it stops fitting

No file a user sees: handlers, services, queries, workers, jobs, CLI. A response shape a screen
renders changes, or a front file must follow → fullstack, one ledger row.

## Per stage — the deltas

- **§1** the backend question is the first one (read-only default until the yes; a project's own
  grant covers it). DB stays `SELECT`/`EXPLAIN`/schema; a migration, DDL or data write → Stop and ask.
- **§3** statements at the API: request → status + body. ≥1 negative from: wrong input, missing
  right, a foreign tenant's id, the dependency down.
- **§4/§7** `skip "no visible surface"`.
- **§5** the backend checklist of stages.md §5, item by item; the project's backend canon first,
  `<kit>/skills/deep-review/references/backend.md` the floor, its sweep over your added lines.
  Secrets never printed, logged or committed.
- **§9** the reviewer's lens is deep-review's backend.md, plus data-deploy.md when queries, config or
  deploy files moved. Access, ownership, money, schema and concurrency are T2 markers — risk-tier
  lifts them; the one §9 `deep-review` gets them as hints and sizes itself.
- **§10** the endpoint itself on a local stand — `curl` or the project's API tests: the positive, the
  wrong request, the missing right. Substitute only the network edge or an external paid API, never
  the handler, the query or the driver. Red run: the same requests on the branch point when it builds
  without a rebuild of the stand, else «red run: not run — <why>» beside the `mustfail` verdict.
- **§6** the CI jobs of the backend packages; a runtime the laptop lacks → CI's image (gates.md). Read
  the CI `rules:` — a suite gated on the trunk never runs on this MR, so §6 is its only run and the
  report says so.

## Cut vs the universal flow, and why

- BEFORE/AFTER shots, the browser walk, front i18n and the front style profile — nothing to see;
- the design re-check — no screen.

## Loads

Skills: `agentdeck-kit:deep-review` (lens only), `agentdeck-kit:api-contract-sync` when a response or
request shape changes, `agentdeck-kit:log-forensics` when the defect came as a log,
`agentdeck-kit:unit-integration-tests` for the missing test. MCP: forge and tracker as discovered; no
Figma, no browser.

## Limits

The tier caps hold: T1 3 entry points walked, T2 6. A gate the local machine cannot run is
reproduced in CI's image, never `skip`.
