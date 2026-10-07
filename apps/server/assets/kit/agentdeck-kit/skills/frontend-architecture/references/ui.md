# Module: markup and shared components (design system)

## Primitives instead of raw tags

- `p`/`h*`/text `span` → **Typography** (DS `variant`, polymorphic `as`, `color`/`align`/
  `weight`/`truncate` from tokens).
- `div`(flex) → **Stack** (VStack/HStack: `gap`/`align`/`justify`/`wrap`).
- Buttons → **Button** (`variant`/`size`/`fullWidth`, slots `leftIcon`/`rightIcon`/icon-only+`aria-label`,
  states `loading`/`disabled`).
- Inline `svg` → **Icon** (one `size`/`color`/`aria`). Spacing containers → **Box**/**Spacer**.

## MAXIMUM replacement (doctrine; pixel parity is secondary)

Apply primitives MAXIMALLY, not only where they match 1:1. A before/after pixel diff tells that nothing
BROKE; it does not forbid normalisation.

- **Typography variant = nearest DS variant** (font-size + weight): `headline/*`→`heading*`,
  `long text/400`→`body*`, `short text`→`short*`. Raw class had no (or a crooked) `line-height` → take
  the DS variant's (normalising to the DS is GOOD; a slight line-height change is fine). Never keep a tag
  raw just for a zero diff.
- **Keep raw only where replacement is truly impossible:** `<a>` (Typography has no `as="a"`); a label
  inside `<button>` whose font comes from the button class (no separate text class); a pure layout/icon
  `span` without text; dev-showcase chrome (gallery wrappers — not product UI).
- **Colour** — `color` prop when background/inheritance gave non-`default` (Typography forces `fg-default`).
  **Weight** beyond the variant — `weight` prop. Remaining NON-typography (tabular digits
  `font-feature-settings`, `text-overflow`/`line-clamp`, `text-align`, `white-space`) stays in a trimmed `className`.

## Flex container → Stack (sanctioned pattern)

- **Stack is polymorphic and forwards attributes:** `as` prop (default `div`; `section`/`nav`/`ul`/
  `header`/… allowed); `role`/`aria-*`/`id`/`onClick`/`data-testid`/… reach the element via `...rest`. So
  Stack replaces **ANY** flex container, not only a bare div.
- **Convert ALL flex containers** (`display:flex`): plain `div`s, flex `section`/`nav`/`ul`/`header`
  (via `as="section"` etc.) and flex `div`s with `data-testid`/`role`/`aria-label` (forwarded as props).
  "Kept on scss because of data-testid/semantics" is no excuse — Stack covers all of it.
- Plain `<div>` with `display:flex` → `<VStack>`/`<HStack>` (column/row).
- **Layout via Stack PROPS, not a scss class** (Stack has `gap`/`padding`/`margin`/`marginTop`/
  `width`/`align`/`justify`/`wrap`; number → px, STRING → as is, so **pass tokens as strings**):
  `align-items`→`align`, `justify-content`→`justify`, `flex-wrap`→`wrap`, `gap:var(--spacing-sm)`→`gap="var(--spacing-sm)"`,
  `padding:…`→`padding="var(--…)"`, `margin`/`margin-top`→`margin`/`marginTop`, `width`→`width`.
  Example: `<VStack gap="var(--spacing-md)" padding="var(--spacing-md) var(--page-padding-x)" align="center">`.
- **Goal — delete the layout scss class**: once flex/gap/padding/margin/width moved to props and the
  class is empty → delete it, pass no `className`. Non-layout styles left (border/background/shadow/
  complex `background`/`composes`) → keep a trimmed `className` beside the props.
- **grid/absolute/carousels/overlays/special layouts** stay on scss (Stack is only a flex column/row).
- **inline-flex** and flex with a scroll container on `ref` — case by case: Stack covers it (`overflow` in
  className, no ref needed) → convert; otherwise keep + mark.

## Dedup repeated components (NO copies)

One presentational component duplicated across many places (typical: showcase `GallerySection` in every
`*PreviewGallery`) = **one shared component in `shared/ui`**, NOT a copy per folder. "1 file = 1
component" never means copy-paste: dedup into the shared layer first, then use it. Showcase
`GallerySection` lives in `shared/ui/gallery-section` (dev chrome); showcases import it.

## Tokens and Figma

- **DS tokens only** (colours/spacing/typography). Hardcoded values forbidden. Exception: `border-radius`
  is a numeric literal → `styles.md`.
- Missing values/variants → from the **official Figma MCP** (global CLAUDE.md §Figma; skill
  `agentdeck-kit:figma-parity`): name the node needed and why, then wait; never ask the user to switch tabs for what the
  MCP can reach. Reference frames → the project's Figma binding in project-profile.

## Implementing primitives

- In `shared/ui/<name>/` (kebab-case) per structure.md (folder + `.types.ts` + `index.ts` + story).
- Polymorphic `as` via generic props, no `any`.
- Keep/improve accessibility: icon-only Button requires `aria-label`; `Trans` + button must not break axe;
  semantic tags via `as`.
- New reusable pattern → `shared/ui` first, then use. Candidates beyond the set (Card/Divider/Badge) —
  propose as a list, never pull in unconfirmed.
- Component state/variants via discriminated unions in types, not a pile of inconsistent boolean props.

## Red flags

- Hardcoded colour/spacing/font instead of a token. Raw `div`/`p`/`h*`/`svg`/local button in code.
- Guessed a DS value instead of requesting the Figma node. icon-only Button without `aria-label`. `any` in polymorphism.
