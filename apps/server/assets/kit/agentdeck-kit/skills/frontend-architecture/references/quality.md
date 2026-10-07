# Module: code quality

Threshold/contested rules read as: **rule · signal · when NOT to apply**.

## File size

- Rule: split big modules into cohesive parts.
- Signal: **~400 lines** `.ts/.tsx` — a prompt to think, not a hard ban.
- Not for: tests, `*.module.scss`, `*.constants.ts`, `*.mock.*`, generated code.
- Don't split when splitting tears a cohesive component into illogical pieces for the counter's sake.

## Splitting and "one unit — one file"

- Big component → small independent sub-components (each per structure.md).
- One hook / util / helper — one file (hooks in `hooks/`, utils in `lib/`/`utils/`, uniformly).

## Readability

- Blank lines between logical blocks: declarations → logic → effects/handlers → `return`.
- Meaningful names + a short comment on the non-obvious (business rule, workaround); never comment the obvious.
- Avoid nested ternaries and extra `if` nesting → early return/guard.
  - Not when: one tidy nested guard beats an artificial split into functions for the rule's sake.

## Control flow

- Rule: **a loop body is one action; no iteration inside an iteration.** The second traversal level is
  flattened (`flatMap`, `Object.entries()`, a named function over one element); branching that decides
  WHAT to accumulate moves into its own early-return function — not a ternary inside a call argument.
- Signal: block depth inside a function > 2 (a loop plus one `if`) · an `if` wrapping the whole loop body
  (→ `continue` on the first line) · accumulation spread across `if/else` branches.
- Not when: the data itself is 2-D (matrix, tree level) — nesting stays, but the inner pass is still a
  named function, not an anonymous body.
- Machine part — measured, not believed: `max-depth: 3` and `max-nested-callbacks: 4` are usually cheap;
  `complexity` on mature code goes red by the hundreds. Measure before enabling:
  `npx eslint src --rule '{"max-depth":["error",3]}' -f json`.
- Why a separate rule (a real MR review): the project canon described WHERE
  declarations go and was silent on the body's shape — a nested loop passed three green gates and a review
  pass that moved the body into its own file without reading it. A placement rule is no shape rule.

## Props

- Rule: >3 props → pass an object. → ADR-004.
  - Not when: 4 obvious primitives where a wrapper object is just noise; readability beats the counter.
- Prop types only in interfaces (`<Name>Props` in `*.types.ts`), never inline. Destructuring in body or
  signature, uniformly.

## Mock data

- `*.mock.ts(x)` + comment `// MOCK: replace with the real API once the backend exists`. No size limit.

## Optimisation (for a cause, never pre-emptive)

- **Virtualisation** — on measurement: long list + confirmed slowness → TanStack Virtual. NOT everywhere
  by default (breaks page Ctrl+F, complicates a11y and dynamic heights).
- **React Compiler**: check the build config (`babel-plugin-react-compiler` in the vite react plugin).
  Present → no new manual memoisation (`useMemo`/`useCallback`/`memo`) without an explicit reason. Absent →
  warn and ask whether to add it; until decided, memoise pointwise (heavy computation / stable references).
- **Never delete memoisation that feeds an effect dependency list** — compiler or not. The reference
  destabilises and the effect re-runs every render (re-fetch, `setState` loop). The compiler bails on
  components using incompatible libraries (Emotion `useTheme`, RHF `watch()`), so "the compiler covers it"
  is not proof. A new `exhaustive-deps` warning after removing a `useCallback` = it fed an effect → put it
  back. Hit twice in real projects: 5 deliberate `useCallback`s kept after the compiler rollout, and a
  `useMemo` on `buttons` feeding `useStepButtons`' effect.

## Sources of truth

- JS/TS — current MDN (modern syntax/API). SCSS/Sass — official docs (`@use`/`@forward` instead of
  `@import`, `_` partials, modularity). Project diverging from current docs → into the report.

## Red flags

- Split a readable file for "~400". Nested ternary. Loop inside a loop. Block depth >2 in a function.
  > 3 positional props without an object (without cause).
- Inline prop type. Virtualised/memoised without measurement. Removed a memo that fed an effect. Mock
  without the backend note.
