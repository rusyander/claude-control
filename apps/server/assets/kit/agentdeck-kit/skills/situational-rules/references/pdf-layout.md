# PDF for the user — no blank space

Recurring defect: near-empty pages and page-sized gaps, produced by unconditional page breaks before
every section, fixed-height blocks, and unbreakable blocks (figure, note, `break-inside: avoid`) that
do not fit the remaining space and drag their whole block to the next page.

## Build it right the first time

- Flow the content; break only where the content demands it.
- No `page-break-before` per heading. No fixed heights.
- `break-inside: avoid` only on units that actually fit on a page.
- **After every unbreakable tall block put breakable content** (list, table, paragraphs). A tail the
  figure cannot fill, prose fills. Section ending on a figure = a guaranteed tail gap.
- Do NOT chase a gap by shrinking images globally: it re-paginates everything and usually empties the
  LAST page instead. Fix the block that caused it, then re-measure.

## Then verify — on the PRINTED file, before handing it over

The html flow is not the pagination: Chromium moves `break-inside: avoid` blocks, so scrolling the
source by page height LIES. Rasterise the produced `.pdf` page by page and LOOK at every page.

`node <kit>/tools/pdf-blank-check.mjs <file.pdf> [--png <dir>]` — prints per page: share of rows
carrying ink, ink share, longest blank run; `--png` writes the pages as images to open with Read.
Needs Playwright (resolved from the project, else its own folder); pdf.js it installs beside itself
once.

Defect thresholds: rows under ~40%, or a blank run over ~⅓ of the page → fix the layout and
re-render. The last page counts too — end on a real closing block, not on a stub.

Never ship a PDF you have not seen page by page. Re-shot screenshots: check the frame itself first — a
clip with a hardcoded height silently cuts content once the block on screen grows.
