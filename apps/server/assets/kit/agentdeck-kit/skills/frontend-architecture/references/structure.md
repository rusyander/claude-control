# Module: structure and naming (FSD, co-location)

## Co-location

Full rule → **`colocation.md`, not optional**. Digest:

- Each entity owns a folder: `Xxx.tsx` + `Xxx.types.ts` + `Xxx.constants.ts` + `Xxx.module.scss`
  - `Xxx.test.tsx` + `Xxx.stories.tsx`. A satellite BESIDE the folder instead of inside it = defect.
    `index.ts` only at the SLICE boundary; no barrel inside a component folder.
- **Extract a file when there is something to extract.** No 4 empty satellites around a 20-line
  component — types/constants move out when they actually appear, not pre-emptively.
- Styles → **`styles.md`, not optional**: EVERY component owns its `*.module.scss`; a shared
  `<slice>.module.scss` outside `shared` is forbidden; duplicating rules between components is
  accepted and expected. Importing scss from another folder and `composes … from` across a folder
  boundary are forbidden.

## One file — one component (STRICT)

- **Exactly ONE React component per `.tsx`.** No "private sub-component above, main one below". Every
  component, private ones used only by the parent included, gets its own file.
- **Private subview** (needed only by its parent) → its own folder INSIDE the parent's folder:
  `<Parent>/<Sub>/<Sub>.tsx`, parent imports `./<Sub>/<Sub>` — one `.tsx` per directory (fold rule,
  `colocation.md`). Public/reusable sub-component → its own folder at slice level (`ui/<Sub>/`), same
  import shape. No barrel inside either.
- **Non-component content** (utils/helpers/formatters/parsers, hooks, constants, types) does NOT live
  in `.tsx`: util/constant → `lib/` · `<Name>.constants.ts`, hook → beside the store / `hooks/`, type →
  `<Name>.types.ts` (below). The component file holds only the component and its JSX.
- Small icon/logo sub-components (`KindIcon`, `VisaLogo`) are separate files too, not a scatter of
  functions above the main one. Sole exception: the component is physically inseparable (closes over a
  parent local that cannot be passed as a prop) → keep it + a short comment why.

## Naming

- **Folders PascalCase, `shared` layer folders kebab-case; component files PascalCase everywhere**
  (`shared/ui/button/Button.tsx`, `features/Cart/ui/CartList/CartList.tsx`). → ADR-001.
- Satellites per entity: `Xxx.types.ts`, `Xxx.constants.ts`, `Xxx.test.tsx`, `Xxx.stories.tsx`,
  `Xxx.mock.ts`. Props = `<Name>Props`.
- **Name conventions:** components — nouns (`OrderCard`); hooks — `useXxx`; boolean props —
  `is/has/should` (`isLoading`, `hasError`); handlers — prop `onXxx` / inner function `handleXxx`.
- **Named exports** (no `default`). → ADR-003.

## Types and constants

- **COMPONENT types/interfaces ALWAYS in a separate `<Component>.types.ts`** (same component folder),
  NOT inline in `.tsx`: `<Name>Props` and any type serving the component/its props. No inline types in
  a signature/destructuring (`function Foo({ x }: { x: string })`) — move to `.types.ts`.
  Exception — **API types** (network contracts / zod `infer`, `entities` domain models): they live
  beside their API/schema (`*.contracts.ts`, `model/types.ts`), never pulled into a component `.types.ts`.
- A type shared by several components of a feature → lift to feature level (`model/types.ts`), no copies.
- Constants → `*.constants.ts`; keep justification comments (Figma node links) when moving.
- A constant shared by several components → one feature `constants.ts`, not a copy per folder.

## Imports and boundaries (FSD)

- **External imports only through the entity's `index.ts`** (public API). → ADR-002.
- Barrel: **rule** — mandatory at feature/segment (slice) boundaries; never inside a component folder
  (`colocation.md`). Mind import cycles and tree-shaking — no barrel as ritual.
- **Path aliases** (`@/…`, `@shared/…` via tsconfig `paths`) instead of deep `../../../`.
- **Clean named imports.** Import concrete entities by name and use them directly:
  `import { StrictMode } from 'react'` (not `React.StrictMode`), `import { object, string } from 'zod'`
  (not `z.string`). No `import * as ns` and no `Namespace.member` when a named export exists.
  → ADR-007. Exception: the library offers only a namespace/default, or a named import collides.
- Cross-feature imports forbidden (except `features/auth` and `shared/`). Dependency direction:
  `app → pages → widgets → features → entities → shared` (downward only).
- Mechanical enforcement: `config/eslint.config.mjs.txt` + `.dependency-cruiser.cjs` per file, `<kit>/tools/fe-arch-check.mjs`
  for the cross-file shape (lint-enforcement.md).

## Red flags

- 4 satellites around an entity with nothing to extract. scss from another folder. Deep import past `index.ts`.
- Cross-feature import. `default` export of a component. Deep `../../../` instead of an alias.
- **>1 component in one `.tsx`** (private sub-component beside the main one) — move to its own file.
- Util/hook/constant declared in the component file instead of `lib`/`hooks`/`*.constants.ts`.
