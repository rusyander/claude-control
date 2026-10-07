#!/usr/bin/env node
// Structural gate for uncompressed .drawio files.
// Usage: node validate.mjs [--strict] <file.drawio>
//   → "OK: N page(s)" exit 0, or FAIL + list exit 1. --strict (default gate mode): warnings fail too.
import { readFileSync } from 'node:fs';
import {
  styleMap,
  labelSize,
  buildRoute,
  labelRect,
  rectOverlap,
  routeCrossesRect,
} from './geom.mjs';

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const path = argv.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: node validate.mjs [--strict] <file.drawio>');
  process.exit(2);
}
let xml;
try {
  xml = readFileSync(path, 'utf8');
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  process.exit(2);
}

const errors = [];
const warnings = [];
const A = `[^>]*?`; // attr section; format law escapes > in values, so a raw > always ends the tag

if (xml.includes('<!--')) errors.push('XML comments present — remove them');

// tag balance (labels are XML-escaped, so every raw "<" starts a tag)
{
  const tag = new RegExp(`<(/?)([A-Za-z_][\\w.-]*)(${A})(/?)>`, 'g');
  const stack = [];
  let m,
    broken = false;
  while ((m = tag.exec(xml))) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) {
        errors.push(`tag mismatch near </${name}> (offset ${m.index})`);
        broken = true;
        break;
      }
    } else stack.push(name);
  }
  if (!broken && stack.length) errors.push(`unclosed tags: ${stack.join(' > ')}`);
}

// pages
const pages = [];
{
  const re = new RegExp(`<diagram\\b(${A})>([\\s\\S]*?)</diagram>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const name = /name="([^"]*)"/.exec(m[1]);
    pages.push({ name: name ? name[1] : `page${pages.length + 1}`, body: m[2] });
  }
}
if (!pages.length) {
  if (/<mxGraphModel\b/.test(xml)) {
    pages.push({ name: 'implicit', body: xml });
    warnings.push(
      'bare <mxGraphModel> without <mxfile>/<diagram> — wrap it before saving as .drawio',
    );
  } else errors.push('no <diagram> pages and no <mxGraphModel> found');
}

function attrs(s) {
  const out = {},
    re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}
const geomRe = new RegExp(`<mxGeometry\\b(${A})/?>`);
const pointsRe = new RegExp(`<Array${A}as="points"${A}>([\\s\\S]*?)</Array>`);
function parseGeom(seg) {
  const g = geomRe.exec(seg);
  if (!g) return null;
  const a = attrs(g[1]);
  const points = [];
  const arr = pointsRe.exec(seg);
  if (arr) {
    const pr = new RegExp(`<mxPoint\\b(${A})/?>`, 'g');
    let pm;
    while ((pm = pr.exec(arr[1]))) {
      const pa = attrs(pm[1]);
      points.push({ x: +(pa.x ?? 0), y: +(pa.y ?? 0) });
    }
  }
  return {
    x: +(a.x ?? 0),
    y: +(a.y ?? 0),
    w: +(a.width ?? 0),
    h: +(a.height ?? 0),
    hasWH: 'width' in a && 'height' in a,
    relative: a.relative === '1',
    points,
  };
}
function mkCell(a, geom, idOverride, valueOverride) {
  return {
    id: idOverride ?? a.id,
    value: valueOverride ?? a.value ?? '',
    parent: a.parent,
    vertex: a.vertex === '1',
    edge: a.edge === '1',
    source: a.source,
    target: a.target,
    style: a.style ?? '',
    geom,
  };
}
const styleHas = (c, k) => new RegExp(`(^|;)${k}`).test(c.style ?? '');
const fillOf = (c) => (/(?:^|;)fillColor=([^;]+)/.exec(c.style ?? '') ?? [])[1] ?? null;
const strokeOf = (c) => (/(?:^|;)strokeColor=([^;]+)/.exec(c.style ?? '') ?? [])[1] ?? null;

for (const page of pages) {
  const P = `page "${page.name}"`;
  if (!/<mxGraphModel\b/.test(page.body)) {
    errors.push(`${P}: content is not uncompressed XML — re-emit as literal <mxGraphModel>`);
    continue;
  }
  const cells = [];
  const wrapRe = new RegExp(`<(object|UserObject)\\b(${A})>([\\s\\S]*?)</\\1>`, 'g');
  const rest = page.body.replace(wrapRe, (_w, _t, wattr, inner) => {
    const wa = attrs(wattr);
    const cm = new RegExp(`<mxCell\\b(${A})/?>`).exec(inner);
    cells.push(mkCell(cm ? attrs(cm[1]) : {}, parseGeom(inner), wa.id, wa.label));
    return '';
  });
  const cellRe = new RegExp(`<mxCell\\b(${A})/>|<mxCell\\b(${A})>([\\s\\S]*?)</mxCell>`, 'g');
  let m;
  while ((m = cellRe.exec(rest))) {
    const a = attrs(m[1] ?? m[2]);
    cells.push(mkCell(a, m[3] ? parseGeom(m[3]) : null));
  }

  const ids = new Map();
  for (const c of cells) {
    if (c.id == null) {
      errors.push(`${P}: cell without id`);
      continue;
    }
    if (ids.has(c.id)) errors.push(`${P}: duplicate id "${c.id}"`);
    ids.set(c.id, c);
  }
  if (!ids.has('0') || !ids.has('1')) errors.push(`${P}: structural cells id="0"/id="1" missing`);

  const isMaster = /^0[.\s]/.test(page.name);
  const incident = new Set();
  const pairSeen = new Map();
  const fans = new Map();
  const contentFills = new Set(),
    contentStrokes = new Set();
  const sampleFills = new Set(),
    sampleStrokes = new Set();
  let sampleCount = 0,
    contentCount = 0,
    unlabeled = 0,
    offGrid = 0;

  for (const c of cells) {
    if (c.id === '0' || c.id == null) continue;
    if (c.parent != null && !ids.has(c.parent))
      errors.push(`${P}: cell "${c.id}" parent "${c.parent}" not found`);
    if (c.vertex && c.edge) errors.push(`${P}: cell "${c.id}" is both vertex and edge`);
    // sample=1 marks a legend key (swatch, line specimen, caption) — not content.
    const sample = styleHas(c, 'sample=1');
    if (sample) sampleCount++;
    if (c.edge) {
      if (c.source) incident.add(c.source);
      if (c.target) incident.add(c.target);
      for (const end of ['source', 'target']) {
        const v = c[end];
        if (v == null) {
          if (!sample) warnings.push(`${P}: edge "${c.id}" has no ${end} (floating endpoint)`);
        } else if (!ids.has(v)) errors.push(`${P}: edge "${c.id}" ${end} "${v}" not found`);
      }
      const st = strokeOf(c);
      if (sample) {
        if (st && st !== 'none') sampleStrokes.add(st);
      } else {
        if (st && st !== 'none') contentStrokes.add(st);
        if (c.source && c.target) {
          const key = `${c.source}->${c.target}`;
          if (pairSeen.has(key))
            warnings.push(
              `${P}: duplicate edges "${pairSeen.get(key)}" and "${c.id}" (${key}) — merge into one with a combined label`,
            );
          else pairSeen.set(key, c.id);
          if (isMaster)
            for (const end of ['source', 'target']) {
              const t = ids.get(c[end]);
              if (t && styleHas(t, 'container=1'))
                warnings.push(
                  `${P}: edge "${c.id}" ${end}s at card "${t.id}" — connect component→component`,
                );
            }
        }
        // A label may live on the edge value or in a child edgeLabel cell (draw.io's own form).
        const labeled =
          c.value ||
          cells.some((x) => x.parent === c.id && /edgeLabel/.test(x.style ?? '') && x.value);
        if (!labeled) unlabeled++;
        else if (c.target)
          (fans.get(c.target) ?? fans.set(c.target, []).get(c.target)).push({
            id: c.id,
            x: c.geom?.x ?? 0,
          });
      }
    }
    if (c.vertex) {
      const fill = fillOf(c);
      if (sample) {
        if (fill && fill !== 'none') sampleFills.add(fill);
      } else if (!styleHas(c, 'text;') && !/shape=note|edgeLabel/.test(c.style ?? '')) {
        contentCount++;
        if (fill && fill !== 'none') contentFills.add(fill);
      }
      if (!c.geom?.relative) {
        if (!c.geom?.hasWH) errors.push(`${P}: vertex "${c.id}" lacks mxGeometry width/height`);
        else {
          if (!sample && [c.geom.x, c.geom.y, c.geom.w, c.geom.h].some((v) => v % 10 !== 0))
            offGrid++;
          const p = c.parent && c.parent !== '0' && c.parent !== '1' ? ids.get(c.parent) : null;
          if (
            p?.vertex &&
            p.geom?.hasWH &&
            (c.geom.x < 0 ||
              c.geom.y < 0 ||
              c.geom.x + c.geom.w > p.geom.w ||
              c.geom.y + c.geom.h > p.geom.h)
          )
            warnings.push(
              `${P}: "${c.id}" exceeds container "${p.id}" — size the container to hold all children`,
            );
        }
      }
    }
  }

  // isolated filled vertices — a box nothing points at is a missing relation or a stray element
  for (const c of cells) {
    if (!c.vertex || c.id === '0' || c.id == null || incident.has(c.id)) continue;
    // informational=1 marks a block that carries text rather than an architecture node
    // (reference tables, band headers, "declared but absent" placeholders) — it has no edges by design.
    if (
      styleHas(c, 'sample=1') ||
      styleHas(c, 'container=1') ||
      styleHas(c, 'text;') ||
      styleHas(c, 'informational=1')
    )
      continue;
    if (/shape=note|edgeLabel/.test(c.style ?? '')) continue;
    const fill = fillOf(c);
    if (fill && fill !== 'none')
      warnings.push(`${P}: "${c.id}" has no edges — missing relation or stray element`);
  }

  // Converging label positions used to be checked here as a proxy for collisions;
  // the label-geometry pass below measures the actual rectangles, so the proxy is gone.
  void fans;

  // legend: every color used on the page needs a sample=1 key
  if (sampleCount) {
    const missing = [...contentFills]
      .filter((f) => !sampleFills.has(f))
      .concat([...contentStrokes].filter((s) => !sampleStrokes.has(s)));
    if (missing.length)
      warnings.push(`${P}: legend misses color(s) ${missing.join(', ')} used on this page`);
  } else if (contentCount > 8) {
    warnings.push(`${P}: ${contentCount} elements and no legend (sample=1 cells)`);
  }

  const byParent = new Map();
  for (const c of cells) {
    if (!c.vertex || !c.geom?.hasWH || c.geom.relative) continue;
    (byParent.get(c.parent) ?? byParent.set(c.parent, []).get(c.parent)).push(c);
  }
  for (const [par, arr] of byParent) {
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i].geom,
          b = arr[j].geom;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 2 && oy > 2)
          warnings.push(
            `${P}: "${arr[i].id}" overlaps "${arr[j].id}" by ${ox}×${oy}px (parent "${par}")`,
          );
      }
  }
  if (offGrid) warnings.push(`${P}: ${offGrid} vertices off the 10px grid`);
  if (unlabeled)
    warnings.push(`${P}: ${unlabeled} unlabeled edge(s) — architecture edges need verb labels`);

  // ---- label geometry -------------------------------------------------
  // Text must be readable: no label over a box, over another label, or crossed
  // by a foreign line. Rectangles are re-derived here from the written XML.
  const absCache = new Map();
  function absOf(id) {
    if (absCache.has(id)) return absCache.get(id);
    const c = ids.get(id);
    if (!c?.geom?.hasWH || c.geom.relative) return null;
    let x = c.geom.x,
      y = c.geom.y,
      p = c.parent,
      guard = 0;
    while (p && p !== '0' && p !== '1' && guard++ < 32) {
      const v = ids.get(p);
      if (!v?.geom?.hasWH) break;
      x += v.geom.x;
      y += v.geom.y;
      p = v.parent;
    }
    const r = { x, y, w: c.geom.w, h: c.geom.h };
    absCache.set(id, r);
    return r;
  }
  const parentOffset = (pid) => {
    let x = 0,
      y = 0,
      p = pid,
      guard = 0;
    while (p && p !== '0' && p !== '1' && guard++ < 32) {
      const v = ids.get(p);
      if (!v?.geom?.hasWH) break;
      x += v.geom.x;
      y += v.geom.y;
      p = v.parent;
    }
    return { x, y };
  };

  const HEADER = 34; // a card's own title strip — the only part of a card a label must not cover
  const obstacles = [];
  for (const c of cells) {
    if (!c.vertex || c.id === '0' || styleHas(c, 'sample=1')) continue;
    const r = absOf(c.id);
    if (!r) continue;
    if (styleHas(c, 'container=1')) {
      const bottom = /verticalAlign=bottom/.test(c.style ?? '');
      obstacles.push({ id: c.id, x: r.x, y: bottom ? r.y + r.h - HEADER : r.y, w: r.w, h: HEADER });
    } else obstacles.push({ id: c.id, ...r });
  }

  const routes = [];
  for (const c of cells) {
    if (!c.edge || styleHas(c, 'sample=1') || !c.source || !c.target) continue;
    const s = absOf(c.source),
      t = absOf(c.target);
    if (!s || !t) continue;
    const st = styleMap(c.style);
    const off = parentOffset(c.parent);
    const wp = (c.geom?.points ?? []).map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
    const child = cells.find(
      (x) => x.parent === c.id && /edgeLabel/.test(x.style ?? '') && x.value,
    );
    const value = c.value || child?.value || '';
    const size = labelSize(value, +(st.fontSize ?? 10));
    const route = buildRoute(s, t, st, wp);
    const g = child?.geom ?? c.geom;
    routes.push({ id: c.id, route, size, rx: +(g?.x ?? 0), ry: +(g?.y ?? 0) });
  }

  const labels = [];
  const lw = [];
  for (const r of routes) {
    if (!r.size) continue;
    if (r.size.maxLine > 52)
      lw.push(
        `${P}: label of "${r.id}" is ${r.size.maxLine} chars on one line — wrap it (&lt;br&gt;) so it fits a corridor`,
      );
    labels.push({ id: r.id, ...labelRect(r.route, r.rx, r.ry, r.size) });
  }
  for (const l of labels) {
    for (const ob of obstacles)
      if (rectOverlap(l, ob) > 0)
        lw.push(
          `${P}: label of "${l.id}" prints over "${ob.id}" — move it along the edge (geometry x) or off it (geometry y)`,
        );
  }
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (rectOverlap(labels[i], labels[j]) > 0)
        lw.push(`${P}: labels of "${labels[i].id}" and "${labels[j].id}" print over each other`);
  for (const l of labels)
    for (const r of routes) {
      if (r.id === l.id) continue;
      if (routeCrossesRect(r.route, l)) {
        lw.push(
          `${P}: line of "${r.id}" runs through the label of "${l.id}" — reroute or move the label`,
        );
        break;
      }
    }
  // a line must not be drawn across a box it neither starts nor ends at
  const solids = obstacles.filter(
    (o) => !styleHas(ids.get(o.id) ?? {}, 'container=1') && !styleHas(ids.get(o.id) ?? {}, 'text;'),
  );
  for (const r of routes) {
    const e = ids.get(r.id);
    for (const ob of solids) {
      if (ob.id === e.source || ob.id === e.target) continue;
      if (routeCrossesRect(r.route, ob, 4)) {
        lw.push(`${P}: line of "${r.id}" crosses box "${ob.id}" — route it through a free channel`);
        break;
      }
    }
  }
  if (lw.length > 20) {
    warnings.push(...lw.slice(0, 20));
    warnings.push(
      `${P}: +${lw.length - 20} more label-geometry warning(s) — fix the listed ones and rerun`,
    );
  } else warnings.push(...lw);
}

if (errors.length) {
  console.error(`FAIL: ${errors.length} error(s)`);
  for (const e of errors) console.error('  E ' + e);
  for (const w of warnings) console.error('  W ' + w);
  process.exit(1);
}
if (strict && warnings.length) {
  console.error(`FAIL(--strict): ${warnings.length} warning(s)`);
  for (const w of warnings) console.error('  W ' + w);
  process.exit(1);
}
console.log(`OK: ${pages.length} page(s)`);
for (const w of warnings) console.log('  W ' + w);
