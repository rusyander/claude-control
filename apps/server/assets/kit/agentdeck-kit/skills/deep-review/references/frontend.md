# Frontend floor — React / TS / forms / query / router / i18n

Same contract as [backend.md](backend.md): the canon first; a canon rule contradicting a line here
wins, noted once in the profile journal. A hit is a candidate, proven at its P-rung or struck with its
reason. !778's frontend misses were all diff-visible: an unencoded route param, a reset eating input,
a tab unmount, a page kept on filter change, raw codes on screen, an `_other`-only plural.

## Sweep — added lines, `file:line` (backend.md's awk, pathspec `'*.ts' '*.tsx'`, then `grep -P`)

```text
state  useEffect\(\(\) =>\s*set\w+\(               prop/query copied into state: stale commit (P1, P7)
state  key=\{(i|idx|index)\}|key=\{Math\.random     row inputs follow the index after a delete (P1 delete row 0)
state  useState<\w*(Item|Row)|setSelected\(\w+\)     object kept, not id: acts on a stale row after refetch (P2)
state  useEffect\([^)]*\[\]\)                        mount-once POST: doubles in StrictMode, re-entry, tab remount (P3)
state  \{\s*[\w.]*(length|count|total)\s*&&         renders a literal 0
state  useMemo\(\(\) => watch\(                      RHF watch frozen inside memo → useWatch
query  onError:|if \(error\) toast                   a toast per observer: N mounts, N toasts (P1)
query  onSuccess: \(\) => \{\s*\w+\.invalidate       invalidate not RETURNED: pending ends before the refetch, stale flash (P2)
query  mutateAsync\(                                 without catch: unhandled rejection
query  placeholderData: keepPreviousData             old rows stay actionable unless gated by isPlaceholderData (P2)
query  data!\.|as \w+(Dto|Response)                  shape trusted: 204, empty 200, null crash the render (P2)
query  JSON\.parse\(|push\(\.\.\.|new Date\(\w+\)    external data throwing inside render (node one-liner)
form   defaultValues:\s*\w*(data|\?\.)               async data cached at first render as undefined (P2)
form   values:                                       no resetOptions.keepDirtyValues: focus refetch wipes typing (P1)
form   handleSubmit\(\(?\w*\)? => \w*\.?mutate\(    onValid returns void: isSubmitting drops at once, Enter resubmits (P2, POST count)
form   handleSubmit\(async                           no try → setError: a 422 becomes an unhandled rejection
form   disabled=                                     near register: submits undefined, the PATCH clears the field
form   onChange=\{\(?v\w*\)? =>[^}]*(Number\(|!\)|as string)   Mantine Select allowDeselect: second click → null → 0/NaN
url    `[^`]*/api/[^`]*\$\{[^}]*(id|Id|slug|params)  CSPT: the router restores %2F → `..%2F..%2Fadmin` hits another endpoint; encodeURIComponent('..') is '..' — a format check (^\d+$, uuid) is the fix (P1)
url    useState\(\w*\.?(searchParams|params)\.get    URL state read once: back/forward ignored
url    setSearchParams                               a filter change that keeps `page`: page 5 of 2, empty
url    startsWith\(['"]/['"]\)                       near redirect/returnTo/next: `//evil.com`, `/\evil.com` pass; new URL(v, origin).origin === origin
i18n   ^(export )?const .*\bt\(|message:\s*t\(       t() at module scope or in a schema: frozen in the first language
i18n   t\('[^']+',\s*\{\s*(?!count)\w+:              plural variable not named count: _few/_many never picked (node i18next ru, 1/2/5/21)
i18n   __html:\s*t\(                                 translation HTML with escapeValue:false — 🔵
sec    origin\.(indexOf|includes|endsWith|startsWith)\(   postMessage origin by substring: trusted.com.evil.net passes — 🔵
sec    window\.open\(|location\.(assign|replace|href)   non-JSX URL sinks take javascript: in every React version — 🔵
a11y   <Tooltip(?![^>]*events=)                      hover-only: the keyboard never sees it
a11y   <Modal(?![^>]*title=)|<(Select|TextInput)(?![^>]*(label|aria-label)=)   no accessible name
test   waitFor\(\(\)\s*=>\s*(?!\{|expect)            boolean callback resolves at once: the wait is decoration
test   queryBy\w+\([^)]*\)\)\.not\.                  absence asserted before async settles: vacuous
test   vi\.mock\(['"]@(entities|features|shared|widgets)/   own module mocked: the test proves the mock
test   expect\(await [^)]*\.(isVisible|textContent|count)\(\)\)|waitForTimeout   Playwright without auto-wait
perf   from ['"](lucide-react|@mui/material|lodash|react-icons)['"]   barrel import of a heavy library (P6)
```

## What the sweep cannot see

- **Entity switch:** a page reading `useParams` keeps its `useState` from id to id unless keyed
  `key={id}` — A's draft is sent for B. Tabs with `keepMounted={false}` unmount and drop form state.
- **Query key:** every value the queryFn reads is in the key (`@tanstack/query/exhaustive-deps`), or
  another entity's cache answers and nothing refetches.
- **Status order:** `isPending → isError → data` swaps a valid list for an error page when a background
  refetch fails; data first, the error as a banner. Default `retry: 3` on a 403/404 resource = seconds
  of spinner and four requests.
- **Optimistic update:** `cancelQueries` in `onMutate`, the previous value returned for rollback,
  invalidation gated on `isMutating() === 1` — else an in-flight refetch overwrites and concurrent
  toggles revert.
- **Races:** a typeahead or effect fetch without `signal` or an ignore flag — the last to ARRIVE wins.
  A whole-object PUT without version/If-Match, 409/412 unhandled — the last writer wins silently; an
  API with no version → ❓ to the backend.
- **Form state:** partial `defaultValues`, `reset(x)` moving the defaults, formState read only in
  callbacks (it is a Proxy) — isDirty/isValid stick, the unsaved guard lies. `useBlocker` without
  `beforeunload`; the guard still armed on the post-save navigation. `field.id` sent to the API
  overwrites the server id unless `keyName` is set.
- **Dialog focus:** opens on the least destructive action; closes back to the invoker, or to a logical
  element when that row is gone.
- **Security by version:** React ≥19 neutralises `javascript:` in JSX URL attributes (JSX sink 🟡;
  React 18 🔴🔵). `target=_blank` without rel is 🟢; `window.open` without `'noopener'` 🟡🔵. A state
  change through GET with cookie auth passes SameSite=Lax.
- **Tests that lie:** a shared `new QueryClient()` without `retry: false` — error tests time out, cache
  leaks; a mutation test asserting only the optimistic row — assert the request and the refetch.

## Proof rungs — the repository stays untouched, `$S` = scratch

- **P0 lint probe:** eslint 9 + react-hooks + @tanstack/eslint-plugin-query + testing-library in
  `$S`, over the changed files: `--no-config-lookup -c $S/eslint.probe.config.mjs --no-inline-config
-f json`. Each hit is read.
- **P1 vitest on repo code:** junction `$S/node_modules` → the repo's (`cmd //c "mklink /J …"`, removed
  with `rmdir`); a config spreading the repo's `vitest.config.ts` with `root: <repo>`, `cacheDir` and
  `test.dir` in `$S`. `git status` unchanged after.
- **P2 network:** MSW if present, else the repo's own transport stub at the same boundary — `delay(300)`,
  403 plus a call count, 204, `text('<html>')`, `error()`, `delay('infinite')`; inverse delays for a race.
  MSW's implicit delay is 0 in Node — pass milliseconds.
- **P3** `<StrictMode>` plus a request count: more than one on mount = a non-idempotent effect.
- **P4** `vi.useFakeTimers({ shouldAdvanceTime: true })` with `userEvent.setup({ advanceTimers:
vi.advanceTimersByTime })`.
- **P5 Playwright:** `page.route` fulfilling 403 or delaying 1500 ms; two contexts for a lost update;
  `clock.install()` + `fastForward` for expiry; `toBeFocused()` after Escape.
- **P6 bundle diff:** base via `git archive` into `$S`, `vite build --sourcemap` per side,
  `source-map-explorer --json`, totals compared.
- **P7 render count:** `<Profiler onRender>` inside P1, the same interaction at base and head.

On the ladder of [live-proof.md](live-proof.md): P0–P4, P6, P7 are L1; P2 against the real backend is
L3; P5 against the stand is L4.
