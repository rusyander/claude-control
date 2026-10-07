# JS/TS + React canon — audit playbook

Judge React by React canon and the libraries the project actually uses. Every checklist item turns
into a finding only with `file:line` evidence. Review areas = subagent split.

## A. Components & hooks

- Rules of hooks hold everywhere: no conditional/looped hooks, custom hooks named `use*`.
- Derived data is computed during render (or `useMemo` when measured-hot) — never mirrored into
  state and synced by effect.
- `key` is stable identity, never array index on reorderable lists.
- Components stay presentational at their tier: data fetching lives in the data layer / route
  loaders / query hooks, not sprinkled in leaf JSX.
- `memo`/`useCallback`/`useMemo` only where a measured re-render cost exists — blanket memoization
  is itself a finding (P3, noise + stale-closure risk).
- Error boundaries exist at route/feature level; a thrown render error cannot blank the whole app.

## B. State & data layer

- Server state lives in a server-cache lib (TanStack Query / SWR / RTK Query): dedup, retries,
  invalidation. `useEffect` + `fetch` + `setState` chains for server data = P2.
- Client state: local first (`useState`), lifted only as far as actually shared; a global store
  (zustand/redux) holds only genuinely global slices. Whole-app context for fast-changing values = P2
  (every consumer re-renders).
- Query keys centralized (key factory), invalidations targeted, no `refetch()` scattered as a fix.
- Mutations handle error + pending states; optimistic updates roll back.

## C. Effects discipline

- Every `useEffect` answers "which external system am I synchronizing with?" — data transforms,
  event handling and derived state do not qualify (React docs "You Might Not Need an Effect").
- Dependency arrays honest (no lint-silenced omissions); cleanup present for subscriptions, timers,
  observers, aborted fetches.
- Effect chains (effect sets state → triggers next effect) = P2 refactor target.

## D. TypeScript discipline

- `strict: true` non-negotiable; audit flags `any` escapes, `as` casts that dodge narrowing,
  `!` non-null assertions in reachable-null paths (P2 each when load-bearing).
- Domain modeling: discriminated unions over boolean flag combos; exhaustive `switch` with `never`
  check; `unknown` at IO boundaries + parse/validate (zod or hand guards) before use.
- API response types come from one source (generated or a single contract module) — duplicated
  hand-typed shapes drifting from the backend = P1/P2 per api-contract-sync.

## E. Bundle & runtime hygiene

- Route-level code splitting (`lazy`/dynamic import) on any multi-screen app.
- Tree-shakable imports: no `import _ from 'lodash'`-style whole-package pulls; barrel files not
  re-exporting heavy subtrees into every consumer.
- Heavy deps justified (moment→dayjs class of findings); duplicate deps across workspace packages.
- Assets: images sized/lazy; no MB-scale base64 inlined in source.

## F. Layering & structure

- Respect the project's own architecture first (FSD, feature-sliced, or its stated convention) —
  the project profile / CLAUDE.md rules OUTRANK this playbook where they conflict.
- Features import downward only (feature → shared); cross-feature sibling imports and shared→feature
  back-imports = P2 (madge/dep-cruiser artifact backs this).
- One module = one responsibility: types/constants/utils split out of component files where the
  project mandates it; god-files >400 LOC flagged from the complexity artifact.

## G. Testing & tooling baseline

- Test runner + RTL present and green; tests assert behaviour (roles/text), not implementation
  (state internals, snapshot walls).
- Lint config real: react-hooks plugin on, no wholesale rule disables; CI runs typecheck+lint+test.
