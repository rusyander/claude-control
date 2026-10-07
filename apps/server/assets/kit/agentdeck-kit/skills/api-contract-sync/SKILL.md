---
name: api-contract-sync
description: 'Use when front↔back API contracts drift (client types vs OpenAPI/actual responses) — locate the mismatch, fix frontend only.'
---

# Contract sync, front ↔ back

⚠️ Global rule: **backend is read-only.** Read the sources of truth, change the client side only.

## 1. Sources of truth, most reliable first

1. **Actual responses** from the live API (Playwright/curl against the stand) — a spec can lie,
   runtime cannot. Stand unreachable → fall back to the spec and mark the affected rows
   `actual: unverified`.
2. Spec: OpenAPI/Swagger (`contracts/`, `/swagger`, annotations), protobuf, GraphQL schema.
3. Backend code, read-only: response structs / serialization — when there is no spec.

## 2. Compare

Per endpoint the frontend uses: client type/parsing ↔ spec ↔ actual response. Look for missing and
extra fields · drifted types (string vs number, **nullability**) · naming case (snake ↔ camel) ·
enum values · envelopes (`{data: …}` vs flat) · error shape (a project may have several — check
project memory). Large scope → split by domain.
Gate: endpoint list from a grep of the api layer (project convention, e.g. 1 endpoint/file);
report "N found / N compared".

## 3. Report & fixes

- Table: endpoint → field → spec/actual → frontend → mismatch → whose side.
- Frontend fixes, on approval: types, parsing, missing-field handling. The project generates types
  from the spec → use the generator, never hand-edit its output.
- Backend/spec mismatches → a list for the backend team (file/endpoint/what is wrong). Do not touch
  the backend without an explicit yes.
- Runtime safety: on unreliable seams propose response validation (zod or the project's own) instead
  of a blind `as Type`.

## Red flags — run against the finished sync

- Compared against the spec only, never looked at a real response — specs rot.
- "Fixed" by editing the backend without permission.
- Silenced the drift with `any`/`as`: that is concealment, not a fix.
