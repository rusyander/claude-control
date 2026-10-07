# Sheet anatomy — what an information sheet is made of

The standard page, top to bottom. Coordinates are the generator's; every number here is a default that
content may widen, never narrow.

## 1. Skeleton

1. **Title block**, top-left: `<subject> — <what the sheet traces>` 28px bold; under it a 13px grey line
   carrying view name, version, date, source of truth (branch/commit), and how to read the sheet
   ("left to right — the request path, at the bottom — the reference panels").
2. **Stage ribbon** under the title: one chip per column in the column's tint, `›` between chips — the
   reading order in one glance.
3. **Legend**, top-right, right-aligned to the canvas margin (design-system §6).
4. **Columns** — the body of the sheet, left → right.
5. **Bus lanes** — 3–4 horizontal corridors between the ribbon and the column tops, where links that
   skip a column ride.
6. **Reference row** — panels flowing left → right under the columns, wrapping into rows.
7. **Footer**, bottom-right: subject · view · "diagram generated from <path>/generate.mjs".

## 2. Column

A column is one stage of the path: frame in the stage tint, a tab header INSIDE the frame (a tab hanging
above it is a negative child y — the gate rejects it) carrying `<b>Stage name</b> — <technology,
port>`. Width follows the widest pane the stage needs; gutter between columns 130 (labels of the links
live there).

Panes inside it, stacked top to bottom, each fitted to its own text:

- **full pane** — `<b>Title</b>` + body lines; the default.
- **half pane** — two side by side when both are short; both take the row's height.
- **gate pane** — accent stroke, for a check or a rule that blocks ("What it checks", "What is absent").
- **strip** — one line across the column, for a heading over a group of panes.
- **chips** — 2–3 columns of one-line boxes, for enumerations (routes, node types, keys).
- A pane whose subject is a store or an external gets its icon in the left indent (design-system §3).

First pane of every column answers "What comes in", last answers "What goes on" — that is what makes
the columns readable as a path.

## 3. Links between columns

Few and short. A link to the neighbouring column runs straight through the gutter; a link that skips a
column climbs to a bus lane, runs above the columns and comes down. Colour = the actor flow it belongs
to, one colour per actor end to end. Every link carries a numbered verb label («3. POST /v1/... [HTTP,
JSON]»). Inside a column, panes are ordered so that no arrow is needed between them.

## 4. Reference row — the catalogue

Each panel is a framed block with its own coloured header (`<b>Name</b> — subtitle`) and one of
three bodies: **mini-diagram** (nodes + arrows), **card flow** (cards wrapping into rows), **table**.
Panel width follows its content, panels flow and wrap, panel height fits its own content — no
equalisation, an empty tail inside a frame reads as a defect.

Pick from this catalogue what the subject has; each entry names the body that fits it:

| Panel                       | Body                                             | Answers                                 |
| --------------------------- | ------------------------------------------------ | --------------------------------------- |
| Sheet terms                 | card flow                                        | what the words on the sheet mean        |
| Launch forms / entry points | mini-diagram: inputs → shared runtime → stores   | which call goes where                   |
| Order of operations         | mini-diagram, snake of numbered steps            | what runs after what                    |
| Entity states               | mini-diagram, state machine with the return edge | what a status allows                    |
| Statuses and outcomes       | mini-diagram, hub left + targets stacked right   | what the history shows                  |
| Restart / retry             | mini-diagram: path + refusal branches            | when it is refused and what to do       |
| Effects of an action        | mini-diagram, one row per action                 | what publish/archive/delete really does |
| Gaps in the code            | mini-diagram, cause → effect pairs               | what is broken, file:line               |
| Open questions              | card flow                                        | what the code does not answer           |
| Limits and ceilings         | table                                            | every hard number and where it is set   |
| Where to look in the code   | card flow with icons                             | entry points for edits                  |

A reference panel earns its place by answering a question a reader will actually ask; a panel that
restates a column is dropped.

## 5. Mini-diagram grammar

- Node = a card: bold title 9px + body lines 8px, fill from the semantic palette, stroke its accent.
- Arrow = short, orthogonal, labelled with a verb or a condition ("publish", "409", "next").
  A label is placed by the algorithm, never by a guessed offset (design-system §5).
- Layouts that read: **chain** (3 cards in a row), **snake** (3 + 3, second row right → left), **fan**
  (hub on the LEFT, targets stacked vertically on the right, gap ≥150 for the labels), **pairs**
  (cause left, effect right, one row per pair), **branch** (path on top, refusals below with explicit
  mid-lane waypoints).
- A downward fan from a narrow hub cannot separate its labels — use the left-hub fan instead.

## 6. Optional extra pages

Only on the interview's yes, as numbered pages after «0. …» — specs in view-catalog.md. They are
additions; nothing moves off the sheet onto them.
