# Module: stylesheet ownership (NON-NEGOTIABLE)

## The rule

**Every component gets its own `<Component>.module.scss`, inside its own folder.** A shared
`<Slice>.module.scss` serving several components is FORBIDDEN in `app`, `routes`, `pages`,
`widgets`, `features`, `entities`.

**Duplication between components is ACCEPTED and expected.** Two components needing the same
`display: flex; gap: var(--spacing-sm)` write it twice. That is cheaper than the coupling it
replaces: one shared sheet means editing one component's layout silently repaints three others, no
rule can ever be proven dead, and deleting the component leaves its styles behind.

## The single exception: `shared`

`src/shared` MAY keep a common stylesheet — token maps, `shared/styles/*.module.scss` partials, a
field skin composed by `input`/`textarea`. That is the kit's job; `shared` exists to be shared.
Nothing above `shared` inherits that licence. Global/reset/token sheets (`app/styles/*`) are not
component stylesheets and are outside this rule.

## Consequences that bite

- **Never `composes: x from '../other-component/…'`.** Copy the declarations instead. CSS `composes`
  across folders is invisible to the JS import graph AND to `tsc` — only a full build catches a
  broken path — and it re-creates exactly the coupling this rule removes.
- **Cross-file descendant selectors silently stop matching.** CSS Modules hash class names per file,
  so `.parent .child`, where `.child` is rendered by another component, breaks the moment the sheets
  are split. Either duplicate the child class into the parent's sheet, or pass `className` down.
- **Splitting an existing shared sheet** — map class → consumers first (which `.tsx` references
  `styles.X`), give each component only its own classes, duplicate every multi-consumer class
  verbatim, distribute `@media` blocks the same way, drop classes nobody references, then delete the
  original. Copy values and comments unchanged: a split is not a redesign.

## Red flags

- A `.module.scss` at a slice root beside component folders.
- A stylesheet outside `shared` with more than one importer (`fe-arch-check` counts them).
- `composes: … from` crossing a component-folder boundary.
- A stylesheet an order of magnitude longer than its component — it is serving somebody else.

## `border-radius` — numeric literal, always

**The rule:** a corner radius is written as a number with its unit, at the point of use:
`border-radius: 8px`, `border-radius: 999px`. Never a theme token (`theme.radius.*`), never a CSS
var (`var(--rs-radius-*)`, `var(--radius-md)`), never a named scale constant. `border-radius: 50%`
and a component library's own prop (`borderRadius="medium"` — a React prop, not CSS) stay allowed.

**Why:** same argument as every other size. A reader of the diff sees the value instead of a name
to chase into another file, and a radius is a local visual decision — the indirection bought
nothing but a lookup. A design scale (8 / 12 / 16 / 999) may still guide which number to pick; it
does not get to live in the code.

Where a token feeds a generator (a design-system build emitting `--rs-radius-*` for a third-party
kit), the token stays in the generator's source and is kept out of the app-facing theme object, so
the escape hatch cannot be reached by accident.

This reverses the earlier "sizes are literals but radius stays on tokens" split.

**The one exception — radius as a public theming input.** Where a documented theme contract lets a host
retune rounding at runtime (e.g. an embeddable widget whose `style-schema.json` publishes a `--radius-*` scale),
a literal silently opts that element out of host theming, so radius stays on the contract's variables
there, and a value outside the contract's scale keeps its literal. The exception needs the published
contract to exist and the project to record the ruling; a wish for consistency is not one.
