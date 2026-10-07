# generate.mjs — the generator contract

The sheet is code. Hand-written XML cannot hold the width law (every box measured), the alignment law
(rows equalised) or the label pass (positions solved) — so the `.drawio` is always output:
`node <folder>/generate.mjs <ABSOLUTE out path>.drawio`. Regenerate after every edit; never patch the XML.

## Spine

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// <kit> = the kit root (see the kit rules); pathToFileURL keeps Windows paths importable
const { pathToFileURL } = await import('node:url');
const geom = await import(pathToFileURL('<kit>/skills/drawio-architect/scripts/geom.mjs').href);
const { labelSize, placeLabel, rectOverlap } = geom;
const OUT = process.argv[2];
const G = 10,
  MARGIN = 60; // grid and page margin
const out = [],
  V = new Map(),
  EDGES = []; // cells, vertex index, links
const r10 = (n) => Math.round(n / G) * G;
const esc = (s) =>
  String(s)
    .replace(/&(?![a-z#]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const safe = (s) => String(s).replace(/[<>&]/g, ' '); // for measuring, not for output

function put(id, value, style, r0, parent, meta = {}) {
  const r = { x: r10(r0.x), y: r10(r0.y), w: r10(r0.w), h: r10(r0.h) };
  const p = parent ? V.get(parent) : null; // child geometry is container-relative
  out.push(`        <mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent ?? '1'}">
          <mxGeometry x="${r.x - (p?.x ?? 0)}" y="${r.y - (p?.y ?? 0)}" width="${r.w}" height="${r.h}" as="geometry"/>
        </mxCell>`);
  V.set(id, { id, ...r, cx: r.x + r.w / 2, cy: r.y + r.h / 2, ...meta }); // V keeps ABSOLUTE coords
  return V.get(id);
}
// text metrics: characters per line at font size fs, then height of a list of lines
const cpl = (w, fs) => Math.max(10, Math.floor((w - 22) / (fs * 0.5)));
const linesH = (arr, w, fs) =>
  arr.reduce((a, l) => a + Math.max(1, Math.ceil(safe(l).length / cpl(w, fs))) * (fs + 4), 0);
const bodyHtml = (arr, fs) =>
  arr
    .map((l) => `<div style="font-size:${fs}px;text-align:left;margin-top:3px">${safe(l)}</div>`)
    .join('');
```

`meta` carries what later passes need: `{ solid: true }` for a box arrows must avoid, `{ frame: true }`
for a container, `{ col }` for the column index.

## Width and height, measured

```js
const CW8 = 4.4; // average glyph width at 8px
function fitW(parts, maxW = 320, minW = 170, target = 2) {
  // width that wraps text into ~2 lines
  const lines = parts.filter(Boolean).map(safe);
  const need = Math.ceil(lines.reduce((a, l) => a + l.length, 0) / target) * CW8 + 30;
  const longest = Math.max(...lines.map((l) => l.length), 8) * CW8 + 30;
  return Math.max(minW, Math.min(maxW, Math.ceil(Math.min(need, longest) / G) * G));
}
const groupW = (items, maxW = 320, minW = 170) =>
  // ONE width per block
  Math.max(...items.map((it) => fitW([it[0], ...(it[1] ?? [])], maxW, minW)));
const nodeH = (spec, w) =>
  Math.max(
    spec.icon ? 56 : 34, // height of one card
    Math.ceil(
      (8 + (spec.title ? 14 : 0) + linesH(spec.lines ?? [], w - (spec.icon ? 46 : 0), 8) + 8) / G,
    ) * G,
  );
const rowHeight = (specs, w) => Math.max(...specs.map((z) => nodeH(z, z.w ?? w))); // ONE height per row
```

Every card takes `h: rowHeight(...)` of its row — that is the whole of the alignment law.

## Columns and panes

`column(id, pal, title, sub, w)` puts the frame with a placeholder height, then the tab INSIDE it, and
keeps a cursor. `pane(c, spec)` places a full or half-width box at the cursor, height `nodeH`, and
advances it; a `kind: 'store' | 'ext'` spec also puts its icon in the left indent. When the column's
content is done, rewrite the frame height from the cursor:

```js
out[c.cellIdx] = out[c.cellIdx].replace('height="9990"', `height="${h}"`);
const v = V.get(c.id);
v.h = h;
v.cy = v.y + h / 2; // keep V in sync — later passes read it
```

The same placeholder trick shrinks reference panels to content: reserve `9990`, patch width and height
in `closePanel()` from the panel's own right/bottom cursor, then set `flowX = panel.x + w + 40`.

## Reference panels

```js
refPanel(wantW, title, sub, accent); // closes the previous panel, wraps the flow if it no longer fits
refFlow(p) / refFlowEnd(p); // opens/closes a mini-diagram area, tracks p.bottom
refNode(p, id, x, y, w, spec); // spec: {title, lines, fill, stroke, ink, icon, iconText, bold, h}
refEdge(a, b, label, opts); // collected, routed later; opts: exit/entry, points, colour
refGrid(p, items, maxW); // cards: pack into rows first, then one height per row
refTable(p, head, rows); // column width from the longest cell, capped ~40 chars
```

`refGrid` packs before it places — compute the row split by width, then place each row with its own
`rowHeight`; placing card by card is what produces ragged bottoms.

## Routing and labels — one pass for every edge

Column links: pin `p0`/`p1` on the facing sides, try a straight hop through the gutter, else a bus lane,
`geom.orthogonalize` the point chain, and reject a route that crosses a solid. Reference arrows: build
the chain from the exit/entry fractions (mid-gutter for a horizontal pair, mid-lane for a vertical one),
same `orthogonalize`. Then, for every edge:

```js
for (const width of [40, 30, 22, 16, 12]) {
  // 24,18,14,10 for 9px reference labels
  const txt = wrap(e.label, width);
  const size = labelSize(txt.split(NL).join('<br>'), 10);
  const p = placeLabel(e.route, size, {
    rects: obstacles,
    lines: otherRoutes,
    fractions: FRACT,
    offsets: OFFS,
  });
  if (p.clear) {
    e.text = txt;
    e.lx = p.x;
    e.ly = p.y;
    break;
  }
}
placedLabels.push({ id: `label:${e.source}`, ...pick.p.rect }); // later labels avoid earlier ones
```

`FRACT = [0.5, 0.42, 0.58, 0.34, 0.66, …]`, `OFFS = [0, -16, 16, -26, 26, …]`. Obstacles: solids +
already-placed labels, plus the column frames for links between columns. Emit exit/entry from the
route's own first/last point, waypoints as `<Array as="points">`, and `x`/`y` from the pass.

## Emit

```js
const CANVAS_H = refMax + 90, CANVAS_W = <last column right> + MARGIN;
const xml = `<mxfile host="app.diagrams.net" version="24.7.7">
  <diagram id="master" name="0. Overview">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="20" guides="1" tooltips="1" connect="1" arrows="1"
        fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${out.join('\n')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, xml, 'utf8');
console.log(`written ${OUT}: ${out.length} cells, ${EDGES.length} edges, canvas ${CANVAS_W} x ${CANVAS_H}`);
```

Report unrouted edges and unplaced labels by name on stderr — a silent fallback route is how a crossing
reaches the gate.

## Traps paid for already

- A container child's geometry is relative, `V` holds absolute — mixing them puts cards outside frames.
- `put` snaps to the 10-grid: a 24px rhythm or a `+2` nudge survives snapping unevenly. Design in tens.
- A tab drawn above its frame is a negative child y — the gate rejects it; the tab goes inside.
- `${…}` inside a template literal that a splice script rewrites: patch by full unique lines, never by a
  regex over `};`.
- Icons and cards share the box width: `w` includes the 46px indent, text width is `w - 46`.
- Re-running a patch script must be idempotent — guard every insertion with a presence check.
