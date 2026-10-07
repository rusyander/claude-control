# Figma access — the user's window, read-only

Figma desktop is already open on the user's machine, on the page with the SCREENS. That window
is theirs. Everything below exists so the run never disturbs it and never invents design data.

## Rules

0. **A local snapshot, where the project has one, is the primary channel; the MCP is the fallback.**
   Before touching a design task, pull a full snapshot of the area — the project's own documented
   script (e.g. a `figma:snapshot` package script → `.agent/figma-snapshot/<key>/` with `outline.txt`,
   `tree.json`, PNG per frame, root `INDEX.md`) over the OFFICIAL Figma REST API with the project's
   own key — never ask the user for one. REST and
   MCP have separate quotas, so the snapshot survives an exhausted MCP; reading it costs nothing
   and works offline. Compare to 100% against it, then ASK before spending quota on a live
   re-check. Refresh only when the user says so or a task lands on an area the snapshot misses or
   covers stale. This does NOT license a third-party "figma MCP" wrapper — see rule 1.
1. **Only the real Dev Mode MCP** (`get_metadata`, `get_design_context`, `get_variable_defs`,
   `get_screenshot`, `get_motion_context`). No REST wrapper, no Playwright against
   figma.com, no browser automation of the app. No `figma` tools in session → tell the user to
   start desktop Figma with Dev Mode and reconnect; do not improvise a substitute.
2. **Never change what Figma shows** — no page switch, no selection change, no zoom, no
   "open the components page" performed by the agent. Selection-based calls are fine only
   because the user set that selection; prefer explicit node-ids from their link.
3. **Default page = screens.** Assume nothing else is reachable: design-system pages, token
   pages, icon libraries, primitive/color specs, component documentation. Their absence is
   normal, not an error.
4. **Orchestrator only.** Subagents never call Figma — they read the cache. One pull per node
   per run; a second identical pull is a bug (rate limit + the user's session).

## Cache layout

```
.agent/figma-parity/ref/<screen>/
  metadata.json      node tree, names, nesting
  context.md         hex colors, fonts, sizes, paddings, radii, state variants
  variables.json     design variables → fix target
  motion.md          prototype/smart-animate timings, if the designer specified any
  figma.png          visual reference (see "getting the image onto disk")
  icons/*.svg
```

Also record the design frame width — the scale policy's `k` depends on it. Cache is a hint,
not truth: if a value decides a fix and the cache looks stale for that node, re-pull that node
only.

## Off-page references never stop the run

A needed reference is off the open page, or a node-id resolves to another page, or a token name
appears in `context.md` with no definition. Then:

- Do **not** navigate, do **not** guess a value from a neighbouring screen, do **not** invent
  a token, and do **not** interrupt the user mid-run.
- Use what the screens page already gives: `get_design_context` on the screens themselves
  reports resolved values (hex, px) even when the variable lives elsewhere. That resolved value
  is enough to reach parity — apply it verbatim per `parity-rules.md` §"exact value wins".
- Log the item in `.agent/figma-parity/ASK-FIGMA.agent.md`: what was needed, which page would hold it,
  which screens used the resolved fallback, and the variable name the spec mentioned.
- Only a reference the screens page cannot resolve at all (a component spec whose values are
  simply absent) marks those specific findings **"value source unconfirmed"** and, if the
  screen cannot be judged without it, the screen as `partial` — never as `ok`.
- All of it surfaces in the final report as one request: which pages to open, and why each
  matters (usually: the tokens page, so the collected palette can become variables).

## Getting the Figma image onto disk

Needed for the Phase 6 side-by-side, and it must not cost image tokens. Probe the chain ONCE
per project and record the winner in `.agent/notes.md`:

1. The MCP exposes local asset URLs (`http://127.0.0.1:3845/assets/...`) in
   `get_design_context` / `get_screenshot` output → a Node one-liner fetches them to
   `figma.png` / `icons/*.svg`. Zero context cost. Preferred.
2. No asset URL → call `get_screenshot` once per screen as visual reference (that image does
   enter context — budget for it, never twice per node), and add "export frames to
   `.agent/figma-parity/ref/<screen>/figma.png`" to the batched request.
3. Neither available → the report shows the front screenshot beside the design **spec table**
   instead of the design image, labelled "mock: spec only, image unavailable".
   Parity conclusions still stand; they were always drawn from numbers, not the picture.
