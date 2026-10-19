# Profile — fullstack

Changes only what it names; order, ledger, authorisations, the one gate, the MR and Stop-and-ask stay
SKILL.md's. Picked at §3 (profiles.md), switched to from frontend or backend when the diff crosses
the boundary, or pinned by a panel group. Each side keeps its own profile's rules
(profile-frontend.md, profile-backend.md); this page adds what the seam between them needs.

## Per stage — the deltas

- **§1** the backend question is asked here (read-only default until the yes).
- **§3** order of work: contract → server → client. A changed contract, schema or shared type is a
  T2 marker — risk-tier lifts it. Statements cover both ends: the endpoint's answer AND what the
  screen shows for it, ≥1 negative crossing the seam (the new error code reaching the UI's message).
- **§5** contract first, drift fixed in the same MR (`agentdeck-kit:api-contract-sync`); then the
  backend checklist; then the client against the REAL local backend — no stub on either side of the
  seam.
- **§9** the one `deep-review` gets both lenses (backend.md, frontend.md) as hints, plus parity both
  ways: every other consumer of the changed endpoint handles what the new one emits.
- **§10** the UI walk against the real local backend, plus the endpoint-level wrong request; the red
  run as T2 owes it.
- **§6** the CI jobs of both sides, one command.

## Cut vs the universal flow

Nothing structural — this is the universal flow with both lenses; the cut is only the stub of the
layer under test.

## Loads

Skills: `agentdeck-kit:api-contract-sync`, `agentdeck-kit:deep-review` (lenses), the frontend and
backend profiles' skills per side. MCP: forge and tracker as discovered, a browser; Figma only when a
mock is handed over.

## Limits

T2 caps: 25 review rows, 6 walked entries; the rest printed as not covered.
