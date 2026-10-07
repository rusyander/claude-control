# Frontend deploy templates (reusable)

Reference frontend deploy files. **Infra is read-only by default** (global Backend rule): a project that
already has Docker/compose/CI is NOT rewritten — on request, propose targeted improvements that break
nothing. Apply only on explicit consent.

## Files

- `Dockerfile` — multi-stage Vite SPA → nginx (static files, not a node server), pnpm, healthcheck.
- `nginx.conf` — SPA fallback + security headers (CSP / X-Frame-Options / nosniff / Referrer-Policy).
- `.dockerignore`, `docker-compose.frontend.yml` — frontend dev stand.

## CI (skeleton, not "universal")

Pipelines (GitLab CI / Jenkins / GH Actions) are too environment-bound for one universal template. The
steps are the same: **install → check (lint + type + test) → build → image**. Build the concrete pipeline
for the project's environment; CI config is infra → propose, never apply (a pipeline file edit needs the
user's yes like any backend/config edit).

## Monorepo

Dockerfile `context` and paths follow the monorepo: copy the needed package, build with
`pnpm --filter <pkg> build`. See `references/tooling.md`.
