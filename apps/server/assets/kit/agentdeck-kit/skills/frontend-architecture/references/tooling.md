# Module: tooling (package manager, package.json, build, monorepo)

## Package manager

- **Idiom wins:** a lockfile exists → use its manager (`pnpm-lock.yaml`→pnpm,
  `package-lock.json`→npm, `yarn.lock`→yarn). Never mix, never swap without consent.
- **Greenfield → pnpm** (fast, strict, native workspaces). Pin in package.json:
  `"packageManager": "pnpm@<version>"` + `"engines": { "node": ">=20" }`.

## package.json (conventions)

- Uniform scripts; **one verification command** `check` (format → type-check → lint →
  depcruise → build), e.g.:
  `"check": "prettier --check . && tsc --noEmit && eslint . && depcruise src && vite build"`.
- `"type": "module"`; correct `name/version/private`; dev and prod dependencies separated.
- Pull configs from the doctrine's `config/` via `extends`/import, never hand-copied.

## Build and tests (config/)

- `config/vite.config.ts` — Vite + React + aliases (in sync with tsconfig `paths`).
- `config/vitest.config.ts` — Vitest (jsdom, setup, coverage). Default runner Vitest; another one
  (Jest) present → idiom wins.
- Insert on consent, adapt plugins/paths to the project.

## Monorepo (know the shape first)

- **Detect:** `pnpm-workspace.yaml` / `workspaces` in package.json / `turbo.json` / `nx.json` → monorepo;
  otherwise a single package. project-onboard records it in the profile — read the profile first.
- **Config placement:** shared base at the root (`eslint.config.mjs`, `tsconfig.base.json`,
  `.prettierrc.json`, shipped as `config/prettierrc.json.txt`); packages inherit via `extends`/flat-config import. No per-package copies.
- **FSD per app package:** each app has its own `src/` with layers. Shared monorepo packages are separate
  workspace packages imported as dependencies (`@scope/ui`), never via relative paths.
- **Commands target the package** (`pnpm --filter <pkg> check`), not the whole world without need.
  Dockerfile context and paths follow the monorepo structure.

## Red flags

- Swapped the project's package manager/lockfile. Copied configs instead of `extends`.
- Applied root rules to a monorepo as to one package (or vice versa). Touched another workspace package.
