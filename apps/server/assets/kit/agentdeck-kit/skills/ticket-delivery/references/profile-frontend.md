# Profile — frontend

Changes only what it names; order, ledger, authorisations, the one gate, the MR and Stop-and-ask stay
SKILL.md's. Picked at §3 (profiles.md) or pinned by a panel group.

## Fits, and when it stops fitting

Every planned file is front: components, pages, styles, i18n, front tests, front build config. The
fix needs a server, schema or shared-contract change → fullstack, one ledger row
`03-plan profile → fullstack`, and only then the §1 backend question.

## Per stage — the deltas

- **§1** no backend question unless the code classification found a server defect.
- **§3** statements are what a user sees — text, state, layout, focus — with ≥1 empty or error state.
- **§4/§7** a BEFORE|AFTER pair per screen/state the change touches, one script for both.
- **§5** before the first edit: the style profile (`agentdeck-kit:style-conformance-review` Phase 0)
  and, where the project binds it, `agentdeck-kit:frontend-architecture`. i18n in every locale in the
  same edit. Narrow checks: `vitest related <files> --run`, the package's type-check and lint.
- **§9** the reviewer's lens is `<kit>/skills/deep-review/references/frontend.md` (its sweep runs over
  your added lines before §9). It rides the one §9 `deep-review` as a hint; that skill sizes itself.
- **§10** a browser walk on the dev stand. Backend answers may be stubbed at the network edge only
  (`page.route`), never the component under test. T2 variations, highest yield first: one of the N
  requests the screen fires delayed; a role without the write right; zero rows, then one.
- **§6** the CI jobs this diff triggers for the front packages (CI `changes:` rules decide), one command.

## Cut vs the universal flow, and why

- the backend checklist, DB, migration and API-contract steps — a front-only diff cannot reach them;
- the parity run — only with an authority; a Figma mock handed over makes it the design profile.

## Loads

Skills: `agentdeck-kit:style-conformance-review`, `agentdeck-kit:frontend-architecture` (if bound),
`agentdeck-kit:deep-review` (lens only), `agentdeck-kit:playwright-e2e-tests` when the project has a
harness. MCP: forge and tracker as discovered (discovery.md), a browser; Figma not loaded.

## Limits

The tier caps hold: T1 3 walked entries, T2 6; entries over the cap are printed «NOT WALKED». One
stand boot for §4, §7 and §10; the dev server dies at §13.
