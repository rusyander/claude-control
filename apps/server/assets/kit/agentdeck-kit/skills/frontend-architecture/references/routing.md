# Module: routing

## General

- Screens are routes, **not** `if/else` in a parent. Loading/error/empty states via pending/error
  boundaries and loader data, not a hand-written `if/else`.
- Pages live in the `pages/` layer; the route file only glues (loader + component), heavy logic sits in
  the page/features. Params via typed `Route.useParams()`/`useSearch()`, not prop drilling.
- Simple, uniform route tree: every new page follows one template.

## A router ALREADY exists (React Router / Next / other) — idiom wins

- No second router. Apply the rules **by analogy with the existing one's means**:
  - load data in the loader/route level, not in a component `useEffect`;
  - preload on intent (hover/focus) if the router supports it;
  - error/pending via the router's boundaries (errorElement/Suspense/boundary), not a manual `if/else`.

## Greenfield → TanStack Router (on consent to install)

- `loader` via `queryClient.ensureQueryData(...)` — shares the TanStack Query cache (no double requests).
- `defaultPreload: 'intent'` — hovering a `<Link>` sends data/code ahead ("click on a card → the request
  by id is already in flight").
- `pendingComponent` (+ `defaultPendingMs`/`defaultPendingMinMs` against flicker on fast transitions).
- `errorComponent` — route-level error boundary.
- Heavy pages — `createLazyFileRoute` / `route.lazy` (code on demand, preloaded on intent).

## Acceptance

- URL changes, back/forward work. Intent preload visible in Network. Pending until resolved, errors in the
  error boundary. Loaders share the Query cache. No screens via `if/else` in a parent.

## Red flags

- A second router in a project that has one. Data in `useEffect` instead of a loader. A screen via `if/else`.
- Params drilled as props instead of typed `useParams`/`useSearch`.
