# .drawio XML — format law

## File skeleton (multi-page)

```xml
<mxfile host="app.diagrams.net" version="24.7.7">
  <diagram id="master" name="0. Overview">
    <mxGraphModel dx="0" dy="0" grid="1" gridSize="20" guides="1" tooltips="1" connect="1"
        arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
      </root>
    </mxGraphModel>
  </diagram>
  <diagram id="ctx" name="1. Context">…</diagram>
</mxfile>
```

- Body of `<diagram>` is literal XML, never base64/deflate. Uncompressed always.
- Every page: mandatory `<mxCell id="0"/>` + `<mxCell id="1" parent="0"/>`; content parents to `1`, a layer, or a container.
- ids unique per page; short semantic slugs (`api`, `db`, `e-api-db`) beat generated hex.
- No `<!-- -->` anywhere (parse + token waste). All label HTML XML-escaped inside attributes (`&lt;b&gt;`, `&quot;`, `&amp;`).
- Landscape A4 page 1169×826, grid 20. Supporting pages: drawn area >1.5 pages → split the view instead of shrinking. The master page is exempt — it spans what the system needs (view-catalog §0).

## Vertices and edges

```xml
<mxCell id="api" value="&lt;b&gt;API&lt;/b&gt;" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
  <mxGeometry x="400" y="240" width="240" height="120" as="geometry"/>
</mxCell>
<mxCell id="e-api-db" value="Reads/writes [SQL, 5432]" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;"
    edge="1" source="api" target="db" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

- `vertex="1"` xor `edge="1"`. Every vertex carries `<mxGeometry … width height as="geometry"/>`. Origin (0,0) top-left, y grows downward.
- Waypoints inside edge geometry: `<Array as="points"><mxPoint x="700" y="300"/></Array>`.
- Pinning: `exitX/exitY/entryX/entryY` (0–1) in edge style — use when an edge crosses a container border or several edges share a target; vertically stacked pair → `exitX=0.5;exitY=1;entryX=0.5;entryY=0;`. Otherwise let the router route.
- Non-rectangular shape → matching `perimeter=` (`ellipsePerimeter`, `rhombusPerimeter`), else edges attach to the bounding box.
- Edge label position: `x` on the edge's own `<mxGeometry relative="1">` slides the label between source (−1) and target (+1), `y` offsets it perpendicular — the fix for labels of converging edges printing over each other. Both values come from `scripts/geom.mjs` `placeLabel()`, never from guesswork; the same module is what the gate re-derives them with (design-system: readability law). mxGraph reads `x` as a fraction of TOTAL path length, so the route must be explicit (pinned ends + `<Array as="points">`) or the position is not reproducible. A separately movable label = child cell: `vertex="1" connectable="0" parent="<edge-id>"`, style starting `edgeLabel;html=1;` (the gate counts it as the edge's label), with `<mxGeometry relative="1"/>`.

## Containers and boundaries

- `container=1` in style → children coordinates are RELATIVE to the container top-left; child cells set `parent="<container-id>"`.
- Size the container to hold all children up front — auto-grow on open shifts the layout.
- Cross-boundary edges parent on the common ancestor (usually `1`).
- `collapsible=0` on architecture boundaries — an accidental collapse hides content.

## C4 metadata cells (canonical for C4 pages)

```xml
<object placeholders="1" c4Name="API Gateway" c4Type="Container" c4Technology="Go 1.22, chi"
    c4Description="Routing, authentication, rate limit"
    label="&lt;b&gt;%c4Name%&lt;/b&gt;&lt;div style=&quot;font-size:10px&quot;&gt;[%c4Type%: %c4Technology%]&lt;/div&gt;&lt;div style=&quot;font-size:10px;margin-top:6px&quot;&gt;%c4Description%&lt;/div&gt;"
    id="api">
  <mxCell style="rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#438DD5;strokeColor=none;fontColor=#FFFFFF;align=center;" vertex="1" parent="sys">
    <mxGeometry x="40" y="80" width="240" height="120" as="geometry"/>
  </mxCell>
</object>
```

`id` sits on `<object>`; style/parent/vertex on the inner `mxCell`; geometry inside it. `%name%` placeholders render from the attributes and double as hover tooltips. Non-C4 pages: plain `value` with the same HTML pattern.

## Layers

Worth using past ~15 elements per page. A layer = `<mxCell id="L-nodes" value="Nodes" parent="0"/>` (no vertex/edge attr); cells assign `parent="L-nodes"`. Later layer renders on top. Order: boundaries → nodes → edges → annotations. Hide by default only annotation layers (`visible="0"`).

## Validation contract (what scripts/validate.mjs enforces)

Errors: unbalanced tags, compressed page body, XML comments, duplicate id, dangling parent/source/target, vertex without geometry, missing root cells.
Warnings: sibling bounding-box overlap; a child exceeding its container's bounds; coordinates off the 10px half-grid (the layout law itself is 20 — design-system); unlabeled edges; floating edge endpoints; duplicate same-direction edges between one pair; a filled vertex with no edges; on a master page (name «0. …») an edge ending at a `container=1` card — connect component→component; a page color absent from its `sample=1` legend cells; >8 content cells with no legend; converging labeled edges sharing one label position.
Cells styled `sample=1` (legend keys — swatches, line specimens, captions) are exempt from the edge, grid and isolation checks.
`--strict` — the default gate mode — turns warnings into failures; run without it only for deviations justified in the report.

## Canonical style strings

Every style below is the design system (`references/design-system.md`) expressed as mxGraph attributes;
`<tint>`, `<line>`, `<fill>`, `<stroke>`, `<flow>` come from the column palette.

- column frame: `rounded=1;arcSize=2;fillColor=<tint>;strokeColor=<line>;strokeWidth=3;html=1;verticalAlign=top;align=left;container=1;collapsible=0;informational=1;`
- column tab: `rounded=0;fillColor=<line>;strokeColor=none;html=1;whiteSpace=wrap;align=left;verticalAlign=middle;spacingLeft=10;informational=1;`
- pane / card: `rounded=1;arcSize=12;fillColor=<fill>;strokeColor=<stroke>;strokeWidth=<1|3>;html=1;whiteSpace=wrap;align=left;verticalAlign=top;spacing=6;fontSize=8;fontColor=#37474F;informational=1;`
- reference panel frame: column frame with `strokeWidth=2` and `fillColor=#FFFFFF`.
- table cell: `rounded=0;fillColor=<fill>;strokeColor=#CFD8DC;html=1;whiteSpace=wrap;align=left;verticalAlign=top;spacing=4;fontColor=#37474F;informational=1;`
- edge: `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=<9|10>;fontColor=#37474F;labelBackgroundColor=#FFFFFF;endArrow=blockThin;endFill=1;jettySize=auto;strokeWidth=2;strokeColor=<flow>;` + explicit exit/entry.
- async edge: the same + `dashed=1;dashPattern=6 4;`.
- legend key: any of the above + `sample=1;`.

`informational=1` marks a text-carrying box that legitimately has no edges — without it the gate reports
every pane as an isolated vertex.
