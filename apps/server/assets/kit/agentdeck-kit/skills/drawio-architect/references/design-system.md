# Design system — the visual language of the sheet

## 1. Colour

**Stage palettes** — one per column, each `{ tint, line, ink }`: tint fills the column body, line paints
the tab and the frame, ink writes the tab title. A working set of eight, in reading order:

| Stage                | tint    | line    | ink     |
| -------------------- | ------- | ------- | ------- |
| actors               | #E8F5E9 | #43A047 | #1B5E20 |
| frontend             | #EDE7F6 | #7E57C2 | #4527A0 |
| edge / gateway       | #FCE4EC | #EC407A | #AD1457 |
| runtime service      | #E3F2FD | #42A5F5 | #1565C0 |
| builder / config     | #E0F7FA | #26C6DA | #00838F |
| autonomous / worker  | #E0F2F1 | #26A69A | #00695C |
| modules & neighbours | #F1F8E9 | #7CB342 | #33691E |
| data                 | #FFF8E1 | #FFB300 | #EF6C00 |

**Semantic fills** — one meaning each, used inside panes, cards and reference panels:
`card #FFFFFF` component/neutral · `note #FFFDE7` (stroke #F9A825) explanation · `warn #FFEBEE`
(stroke #E53935) break or limit · `store #FFF3E0` (stroke #FB8C00) storage · `ext #ECEFF1`
(stroke #78909C) external · `ok #E8F5E9` (stroke #66BB6A) success · `err #FFCDD2` (stroke #E53935)
error · `run #E3F2FD` (stroke #42A5F5) in progress · `skip #FFE0B2` (stroke #FB8C00) skipped ·
`off #ECEFF1` (stroke #90A4AE) stopped/unsupported.

**Flow colours** — one per actor, end to end: `#EF6C00` admin · `#2E7D32` end user · `#1565C0` API
client · `#78909C` service-to-service · `#6D4C41` data read/write · `#455A64` transition inside a
reference panel. Every colour used, fill or stroke, appears in the legend.

## 2. Typography

Sheet title 28 bold #1A237E · subtitle 13 #546E7A · column tab 12 bold, its subtitle 9 · pane title 10
bold in the stage ink · pane body 9 · reference panel header 12 bold white on the accent · card title 9
bold · card body 8 · table cell 8 · legend caption 11 · edge label 9–10 on white `labelBackgroundColor`.
`html=1` and `whiteSpace=wrap` everywhere; default font family untouched.

Text is written for a reader, not for a slot: a pane says what the thing does and what it holds, in full
sentences, no abbreviations the reader must decode. Density is the point — the sheet replaces a page of
prose — but every line is a fact from the inventory.

## 3. Shape vocabulary

A store, an external system, a service and a UI are recognised by shape before the caption is read:
`shape=cylinder3;backgroundOutline=1;size=7` store (PG, Redis, ClickHouse; the fill separates them) ·
`shape=cloud` external SaaS/API · `shape=process` service/code · `shape=card` UI · `shape=hexagon` API
endpoint. The icon is 36×46, sits in a 46px left indent of its box, carries a 7px caption («PG»,
«Redis», «API»), and `informational=1` so the gate does not demand edges of it.

## 4. The width law — nothing is stretched to fill its container

This applies to everything on the sheet, globally.

- A box's width comes from its text: enough to wrap it into ~2 lines, capped by its longest single line
  and by a per-block maximum (200–320 for cards). Long text wraps to a third line; it does not widen.
- **One width per block, different widths across blocks**: cards of one block all take the block's
  widest card; the neighbouring block computes its own.
- A panel or a container shrinks to its children — width AND height. Reserve a nominal width for the
  flow, then rewrite the frame from the actual right/bottom edge of what went in.
- A table column takes its longest cell (capped ~40 chars), not an equal share of the panel.
- Panels flow left → right and wrap; a row's height is its tallest panel. A ragged right edge on the
  last row is accepted — stretching to fill it is not. A hole large enough to read as unfinished is
  filled with a panel that carries real content (glossary, provenance), never with air inside a frame.

## 5. The alignment law — rows line up, arrows run straight

- Everything snaps to the 10-grid before layout; a 24px rhythm becomes an uneven one after snapping.
- **One height per row.** Cards of a row take the row's tallest card as their height: bottoms land on
  one line and the arrow between neighbours is a straight segment with no jog. The same holds for a
  vertical stack: one height, one step.
- Connect a neighbour at the same relative point on both boxes (0.5/0.5 for a row) — a straight line is
  a placed line, not a lucky one.
- Corridors are sized for the label that crosses them: ≥90 between cards of a mini-diagram, ≥150 for a
  fan's labels, ≥130 between columns, ≥40 between panels.

## 6. Legend — a strict grid

Columns of `SW(50) + gap(10) + caption`, caption width from the longest caption in THAT column, row step
30, swatch 50×20, caption box the same 20 high with `verticalAlign=middle` so swatch and text sit on one
line. A stage key shows two chips (tint 30 + accent 20) because both colours are used on the page. An
edge key is a real 50px arrow drawn at the row's middle. Every legend cell carries `sample=1` — that is
what tells the gate it is a key, not content. The block is right-aligned to the canvas margin.

The gate collects every fill and every edge stroke on the page and demands a matching `sample=1` key;
vertex strokes are not collected, so an edge colour needs a key that is itself an EDGE.

## 7. The readability law — lines and text never collide

A gate condition, not a preference: **no label may print over a box, over another label, or be crossed
by a line that is not its own.** `validate.mjs` re-derives every label rectangle from the XML and fails
`--strict` on each violation — past ~20 edges the eye cannot be trusted with this.

1. **Bound the text.** ≤52 characters per line, ≤3 lines; longer → wrap with `&lt;br&gt;`.
2. **Route explicitly.** Every labelled edge carries `exitX/exitY/entryX/entryY` plus an
   `<Array as="points">` chain. A route the generator did not choose is one it cannot place a label on.
3. **Lane the runs.** Parallel edges in one corridor get lanes ≥20px apart, allocated per corridor.
4. **Place, don't hope.** `scripts/geom.mjs` `placeLabel()` walks candidate positions along the route and
   returns the first clear one as the `x`/`y` of the edge geometry; the gate recomputes it with the same
   module, so generator and gate cannot drift. Panel arrows go through the SAME pass — a hand-set offset
   is what makes fan labels stack. Obstacles: the cards and the labels already placed, plus the column
   frames for links between columns (a panel's own frame is not one — the arrow lives inside it).
5. **Widen, never shrink.** No free candidate means the corridor is too tight and it grows; a smaller
   font is not the fix, and the least-bad overlap is the defect this law exists to prevent.

Every edge carries a label — an unlabelled arrow is a gate warning, so a fan cannot dodge collisions by
dropping its labels; it changes its geometry instead (sheet-anatomy §5).

The literal style strings that encode all eight laws live beside the format they are written into:
`references/xml-format.md`, section «Canonical style strings».
