# Module: co-location — one folder per component (NON-NEGOTIABLE)

Applies to EVERY layer, every project under this doctrine. Not a taste preference: a flat directory
of 40 files hides which file belongs to which component, makes every rename a manual search, and
lets dead satellites survive their component forever.

## The rule

A component owns a PascalCase folder holding the component AND all its satellites:

    <Component>/
      <Component>.tsx           component + JSX only
      <Component>.types.ts      Props and component-serving types
      <Component>.constants.ts
      <Component>.module.scss   its own stylesheet — see styles.md
      <Component>.stories.tsx
      <Component>.test.tsx

- **Satellites never sit beside the folder.** `Sidebar.module.scss` next to `Sidebar/` is the
  standing mistake — it belongs inside `Sidebar/`.
- **No barrel inside the component folder.** The parent imports `./Sidebar/Sidebar`. `index.ts`
  exists only at the SLICE boundary (the FSD public API).
- **Fold at ≥2.** A directory holding two or more components gets folders for all of them — one `.tsx`
  per directory. This holds inside a component folder too: a private subview of `Parent` lives at
  `Parent/<Sub>/<Sub>.tsx`, never as a second `.tsx` beside `Parent.tsx`. A slice with a single
  component may stay flat — folding one component adds a level and hides nothing.
- **A satellite genuinely shared by several components of the slice stays at the SLICE root**
  (`<Slice>/<Slice>.constants.ts`, `<Slice>/<Slice>.types.ts`) — burying it in one component's
  folder makes its siblings reach sideways into a private directory. Stylesheets are the one thing
  that is never shared this way → `styles.md`.
- **Non-component segments are not foldered per file.** `lib/`, `model/`, `hooks/`, `api/` keep
  their FSD names; inside them the rule stays one unit per file (`lib/buildOrderEta.ts` +
  `lib/buildOrderEta.test.ts`).

## Where the folders live, per layer

- `pages|widgets|features|entities/<Slice>/` — component folders either at the slice root or under
  `ui/`, whichever the project already uses. Pick ONE and keep the whole layer on it: a
  half-migrated layer is worse than either choice.
- `shared/ui/[<group>/]<kebab-slice>/` — slice folder kebab-case, files PascalCase. A one-component
  slice IS the component folder: `shared/ui/button/{Button.tsx, Button.module.scss, index.ts}`, its
  `index.ts` being the slice API (both projects the doctrine was calibrated on, 2026). A slice with
  ≥2 components folds them: `shared/ui/<kebab-slice>/<Component>/`.
- Once a layer passes ~15 slices, group the slices by ROLE:
  `shared/ui/{primitives,form,layout,overlay,feedback,data}/<slice>/`. Never a `misc`/`common`
  bucket — a group nobody can define is a group that will absorb everything.

## Red flags

- Two components' files interleaved alphabetically in one directory.
- `index.ts` inside a component folder re-exporting the single component beside it.
- `<Component>.module.scss` / `.types.ts` / `.constants.ts` one level above its component.
- A directory over ~20 entries that is not `lib/` (one helper per file) or an asset folder.
