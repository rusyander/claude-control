---
name: storybook-stories
description: 'Use when asked to add/set up Storybook stories; CSF3, autodocs, play fns, state coverage; plan for approval before bulk.'
---

# Storybook stories

## 1. Analyze (before writing)

1. **Version and precedent** — `package.json`, `.storybook/main.*`, `preview.*`, existing `*.stories.*`;
   their format wins over taste. SB ≥9: assertions from `storybook/test`, play functions run by
   `@storybook/addon-vitest` (vitest browser mode). SB 8: `@storybook/test` + `@storybook/test-runner`.
   No Storybook → propose an install for the project's framework and builder.
2. **Runner** — does a gate script execute play functions (`test-storybook`, `vitest --project=storybook`)?
   None → play functions are documentation, never evidence; adding the vitest addon becomes a plan item.
   Calibrated on two real admin apps: together they hold 130 play-function files and no
   runner; 54 of them assert nothing.
3. **Providers** components need (theme, i18n, router, query client, store) → global decorators in
   preview, taken from the app shell.
4. **Inventory**: reusable UI (ui-kit/shared) first, then composite widgets; pages only on request.
5. **Plan for approval**: components × stories × the assertion each play function makes. Bulk writing
   starts after the user's yes.

## 2. Writing

- **CSF3**: `const meta = { title, component } satisfies Meta<typeof X>` + typed `StoryObj`; `title`
  mirrors the structure (`Shared/Badge`, `Features/Chat/Input`); autodocs + `argTypes` for controls.
- **Args, not hardcode**: variants through args; `Default` plus spreads `{ ...Default.args, variant: 'x' }`.
- **States matrix**: default / hover-focus (pseudo-states addon if installed, else a play fn) / disabled /
  loading / error / empty / overflow (long text, many items) — what breaks layout in production.
- **Play functions assert**: `userEvent`, then `expect` on the visible outcome — an interaction without
  `expect` is a demo. Query by role or testId; localized text changes with the locale toolbar.
  Portalled content (menus, popovers, modals) renders into the document body — query it via
  `within(canvasElement.ownerDocument.body)` or `screen`.
- **Themes/locales**: globalTypes switchers in preview; critical components get a story per theme.
  i18n runs with `react.useSuspense = false` in preview — a suspended first render leaves play nothing
  to find.
- **Data**: realistic fixtures in the project's language; network-bound components through args,
  loaders or the msw addon — live APIs stay out.

## 3. Verification

1. Gate: `storybook build` (or the project's command) green.
2. Gate: the runner over the new stories — the project's `test-storybook` script — exit 0, counts quoted.
   Run it warm: a `storybook build` right before it invalidates the vitest deps cache, and the cold run
   dies with `Failed to fetch dynamically imported module` (helpdesk-frontend) — rerun before calling
   it red.
3. Each new play function seen red once: `mustfail --mutants` on the component (drop the `onChange`
   call, invert `disabled`), the runner narrowed to the story file —
   `unit-integration-tests/references/weak-tests.md` §The run. No runner → play functions are reported
   as not executed.
4. 2–3 screenshots of key stories to the user.

## Red flags — run against the finished stories

- A play function with no `expect`, or one no gate runs.
- `render: () => <X />` with no args or states.
- Providers copy-pasted per story; a format that differs from the project's stories.
- Text queries in play functions of a localized component.
- Bulk writing without an agreed list.
