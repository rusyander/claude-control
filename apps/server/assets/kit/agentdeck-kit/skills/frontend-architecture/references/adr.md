# ADR — why the contested rules are what they are

Opinionated doctrine decisions. **Preferences, not absolute truth**: on conflict with the project the
project wins (conflict protocol in SKILL.md). Here: the reasoning and when to deviate. Apps may decide
differently — an ADR gives the language for a deliberate deviation instead of an accidental one.

## ADR-001. Naming: folders PascalCase, `shared` folders kebab-case, component files PascalCase

- **Why:** `shared` is a library-like layer (reusable primitives); kebab slice folders visually separate
  "library" from domain code and match npm-package habit. Other layers PascalCase = folder name equals the
  component/entity name. Component FILES stay PascalCase in every layer (`shared/ui/button/Button.tsx`) —
  the file name equals the component it exports; both bound projects converged on this in 2026.
- **Trade-off:** non-standard (many go all-kebab or all-Pascal); drifts without lint.
- **Deviate:** a project with an established single style — follow it, don't break it.

## ADR-002. Barrel `index.ts` as the public API

- **Why:** segment encapsulation — only what is re-exported is visible outside; refactoring internals
  never breaks consumers.
- **Trade-off:** import cycles, weaker tree-shaking in some bundlers, slower TS on large projects.
- **Deviate:** barrels at feature/segment boundaries only, never around every small component.

## ADR-003. Named exports (no `default`)

- **Why:** consistent names through barrels, reliable auto-import/rename refactors, no "two names" for
  one module.
- **Deviate:** where the framework requires default (some route-file conventions; `React.lazy` —
  avoidable via a named re-export).

## ADR-004. >3 props → one object

- **Why:** less positional confusion at the call site, self-documenting, easier to extend.
- **Trade-off:** a wrapper for its own sake is noise in simple cases.
- **Deviate:** 4 obvious primitives where an object adds no clarity.

## ADR-005. API types inline, component types in `*.types.ts`

- **Why:** transport types (request/response) are inseparable from the request function and change with
  it — colocated in one file; component types are bigger and reused — they get their own file.
- **Deviate:** a very large API type set for one resource may move to `model/`, uniformly.

## ADR-006. SCSS modules + `@use`

- **Why:** local class scope (no collisions); repetition via `@use`/`@forward` partials (current Sass
  practice instead of `@import`).
- **Deviate:** a CSS-in-JS/Tailwind project — follow the project (conflict protocol).

## ADR-007. Clean named imports (no `Namespace.member`)

- **Why:** direct named imports (`import { StrictMode } from 'react'`, `import { string } from 'zod'`) —
  better tree-shaking (the bundler sees what is used), explicit module dependencies, less prefix noise,
  easier to grep usages.
- **Trade-off:** longer import lists; possible name collisions.
- **Deviate:** the library exports only a namespace/default (`import * as` unavoidable), or a named
  import collides with a local name — then a namespace/alias is justified.
