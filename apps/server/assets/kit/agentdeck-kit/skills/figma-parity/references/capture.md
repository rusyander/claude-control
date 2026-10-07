# Capture protocol — determinism first

Every flake costs an iteration and can be misread as a defect. Set the environment up so the
same screen photographs identically twice, then measure. Two distinct passes, never mixed:

- **STATIC pass** — motion off, data frozen. Source of geometry/color/type findings and of the
  report's side-by-side shots.
- **MOTION pass** — motion on, states driven (`dynamics.md`). Never used for geometry numbers.

## Static pass setup

Use the project's e2e kit if it exists (`e2e/lib.mjs`, `tools/qa/*`) — auth, base URL and
fixtures already solved there. No kit → a minimal Playwright script, saved to
`.agent/figma-parity/capture.mjs` so later runs and the user can re-run it.

```
viewport      the width agreed in Q3, identical for every screen and every pass
DPR           deviceScaleFactor 2 for crisp shots, but ALL measurements in CSS px
colorScheme   the theme the design is drawn in — check which one before comparing
locale        the locale the design is written in (text length differs per language)
```

Non-adaptive target: that one width is the whole scope. Do not capture other widths, do not
raise responsive findings, do not "improve" the layout for a viewport nobody asked about.

Before any shot or measurement, in this order:

1. `waitForLoadState('networkidle')` — and additionally wait for the app's own readiness
   marker (skeletons gone, spinner detached, a known selector visible). Networkidle alone lies
   on apps that poll.
2. `await document.fonts.ready` — a shot taken on the fallback font gives false type findings.
3. Images/lazy content: scroll the page through once, wait for `img` `complete`, scroll back.
4. Kill motion for this pass: emulate `prefers-reduced-motion: reduce` **and** inject
   `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;
transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`.
   Belt and braces — apps that ignore the media query still get frozen.
5. Freeze the volatile: stub `Date.now`/`new Date` to a fixed timestamp, seed randomness,
   pin feature flags, prefer a seeded fixture user. Relative dates ("2 min ago"), generated
   avatars and IDs otherwise change every run.
6. Dismiss what is not the subject: cookie banners, onboarding tooltips, dev overlays,
   notification toasts. Record what was dismissed — if the design HAS that element, dismissing
   it is a measurement error, not cleanliness.
7. Scroll to a defined position (top, unless the design frame shows a scrolled state) and note
   sticky headers — a sticky bar changes the geometry of everything under it.

## Shots

- `full page` for composition, `clip`/element shot for the block being compared — a full-page
  shot of a 4000px page compared to a 900px frame proves nothing.
- Save to `.agent/figma-parity/shots/<screen>/{before,after,state-*,motion-*}.png`; JPEG
  quality ~75 at ≤1000px width for the report, PNG for the originals kept on disk.
- Mask genuinely undeterminable regions (live charts, video, ad slots) with Playwright's
  `mask` option, and say in the report that they were masked.
- **Every shot is registered when it is taken**, not reconstructed later: id, screen, kind
  (screen/state/motion/data), path, and the Figma node it belongs to. In STRICT mode that register
  is the sweep's inventory and its N (`strict-sweep.md`); in any mode it is what keeps a state shot
  from silently never being compared to anything.

## What is not evidence

Whole-screenshot pixel diff as a verdict (always red across viewports/DPR/fonts) · a shot taken
mid-transition · a value read off a screenshot instead of `get_design_context` or
`getComputedStyle` · "looks the same".

## Negative paths, handled not ignored

Stand down or 5xx → screen status `blocked`, never `ok`; keep going with the rest · auth
expired mid-run → re-auth once, never repeat failed logins (lockouts) · route 404 / screen
behind a flag the run cannot set → `blocked` with the reason · backend returns empty where the
design shows content → that is the empty-state check, run it as such (`dynamics.md`), do not
photograph an empty screen as the screen · modal/overlay stuck open → close deterministically
or capture the underlying screen separately.
