# Module: API layer (axios + TanStack Query in `entities`)

## Transport (axios)

- A resource = a pure axios function: `getUser(id) → response.data`, typed result. Knows nothing of
  React/Query — transport only. Lives in `entities/<entity>/api/`.
- **Response validation at the boundary** (best practice, optional): a schema validator (Zod/valibot) in
  the axios function — runtime check + type inferred from the schema (one source for type and
  validation). New dependency → ask first; already in the project → use it.

## Hooks (TanStack Query)

- A Query hook over the function: `useUser(id)` calls `getUser` via `useQuery`. Components use **only the
  hook** — never axios/fetch directly, never `useEffect` requests. Mutations — `useMutation`.
- The hook lives in `entities/<entity>/api/` (or `model/`, uniformly per project).

## Query keys

- Only through **factory constants** from a dedicated file (`queryKeys.ts`): `userKeys.detail(id)`,
  `userKeys.list(params)`. No string literals across the code — predictable invalidation.

## Types

- **API/hook types stay in the same files** (not moved to `.types.ts`). Deliberate asymmetry with
  components: transport types live beside the transport. → ADR-005.

## Placement (FSD)

- A resource's whole API layer sits in `entities/<entity>/`: axios function + Query hook + keys. Exposed
  via `index.ts`.
- Routing integration: the route loader shares the cache via `queryClient.ensureQueryData(...)`
  (routing.md), no duplicate requests for one id.

## Red flags

- Raw `axios`/`fetch`/`useEffect` request in a component. String query key instead of the factory.
- A component calls the axios function past the hook. API types moved into `.types.ts`.
