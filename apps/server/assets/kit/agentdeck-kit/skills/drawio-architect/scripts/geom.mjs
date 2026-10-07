// Shared edge/label geometry for drawio-architect.
// One implementation used by BOTH sides:
//   - generators, to place a label in free space before writing XML;
//   - validate.mjs, to re-derive the same rectangles from the written XML and fail on collisions.
// Both must agree, so the mxGraph formulas below are reproduced literally
// (mxGraphView.getPoint: relative x in [-1,1] along total path length, y = perpendicular offset).

export function styleMap(style) {
  const out = {};
  for (const kv of String(style ?? '').split(';')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i < 0) out[kv] = '1';
    else out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// XML entities first: a label written as `&lt;br&gt;` is a line break, and stripping
// tags before decoding would leave it as literal text and mis-measure the width.
const unesc = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]*>/g, '');

// Rendered size of a label. Char width is an estimate tuned for Helvetica 10px
// with Cyrillic text; erring wide is intentional — a wide estimate keeps real gaps.
export function labelSize(value, fontSize = 10) {
  const lines = unesc(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const maxLine = Math.max(...lines.map((l) => l.length));
  return {
    w: Math.round(maxLine * fontSize * 0.54 + 12),
    h: Math.round(lines.length * fontSize * 1.32 + 8),
    lines: lines.length,
    maxLine,
  };
}

function sidePoint(r, toward) {
  const cx = r.x + r.w / 2,
    cy = r.y + r.h / 2;
  const dx = toward.x - cx,
    dy = toward.y - cy;
  if (Math.abs(dx) * r.h >= Math.abs(dy) * r.w)
    return { x: dx > 0 ? r.x + r.w : r.x, y: cy, dir: 'h' };
  return { x: cx, y: dy > 0 ? r.y + r.h : r.y, dir: 'v' };
}

function pinDir(r, p) {
  const onSide = Math.abs(p.x - r.x) < 1 || Math.abs(p.x - (r.x + r.w)) < 1;
  return onSide ? 'h' : 'v';
}

// Orthogonal polyline through the given points; inserts an elbow wherever two
// consecutive points share neither axis, continuing the previous direction first.
export function orthogonalize(pts, startDir) {
  const out = [pts[0]];
  let dir = startDir;
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1],
      b = pts[i];
    const dx = Math.abs(a.x - b.x),
      dy = Math.abs(a.y - b.y);
    if (dx > 1 && dy > 1) {
      const vertFirst = dir ? dir === 'v' : dy >= dx;
      out.push(vertFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
      dir = vertFirst ? 'h' : 'v';
    } else if (dx > 1) dir = 'h';
    else if (dy > 1) dir = 'v';
    out.push(b);
  }
  return out.filter(
    (p, i, a) => i === 0 || Math.abs(p.x - a[i - 1].x) > 0.5 || Math.abs(p.y - a[i - 1].y) > 0.5,
  );
}

// s, t: absolute rects. st: parsed style (exitX/exitY/entryX/entryY honoured).
// waypoints: absolute points already resolved against the edge's parent offset.
export function buildRoute(s, t, st, waypoints = []) {
  const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  let start = st.exitX != null ? { x: s.x + +st.exitX * s.w, y: s.y + +st.exitY * s.h } : null;
  let end = st.entryX != null ? { x: t.x + +st.entryX * t.w, y: t.y + +st.entryY * t.h } : null;
  if (!start) start = sidePoint(s, waypoints[0] ?? end ?? tc);
  if (!end) end = sidePoint(t, waypoints[waypoints.length - 1] ?? start ?? sc);
  const dir = start.dir ?? pinDir(s, start);
  return orthogonalize([{ x: start.x, y: start.y }, ...waypoints, { x: end.x, y: end.y }], dir);
}

export function pathSegments(pts) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(d);
    total += d;
  }
  return { segs, total };
}

// mxGraphView.getPoint for a relative edge-label geometry.
export function pointAt(pts, rx, ry = 0) {
  const { segs, total } = pathSegments(pts);
  if (!total) return { ...pts[0] };
  const dist = (rx / 2 + 0.5) * total;
  let acc = 0,
    i = 0;
  while (i < segs.length - 1 && acc + segs[i] < dist) {
    acc += segs[i];
    i++;
  }
  const seg = segs[i] || 1;
  const f = (dist - acc) / seg;
  const p0 = pts[i],
    pe = pts[i + 1];
  const dx = pe.x - p0.x,
    dy = pe.y - p0.y;
  const nx = dy / seg,
    ny = dx / seg;
  return { x: p0.x + dx * f + nx * ry, y: p0.y + dy * f - ny * ry };
}

export const labelRect = (pts, rx, ry, size) => {
  const c = pointAt(pts, rx, ry);
  return { x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2), w: size.w, h: size.h };
};

export function rectOverlap(a, b, tol = 1) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > tol && oy > tol ? ox * oy : 0;
}

// Orthogonal segment vs rect: the segment's bbox is the segment, so a bbox test is exact.
export function segCrossesRect(p, q, r, tol = 2) {
  const x1 = Math.min(p.x, q.x) - 1,
    x2 = Math.max(p.x, q.x) + 1;
  const y1 = Math.min(p.y, q.y) - 1,
    y2 = Math.max(p.y, q.y) + 1;
  return x2 > r.x + tol && x1 < r.x + r.w - tol && y2 > r.y + tol && y1 < r.y + r.h - tol;
}

export function routeCrossesRect(pts, r, tol = 2) {
  for (let i = 1; i < pts.length; i++) if (segCrossesRect(pts[i - 1], pts[i], r, tol)) return true;
  return false;
}

export const DEFAULT_FRACTIONS = [
  0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86, 0.09, 0.91,
];
export const DEFAULT_OFFSETS = [0, -22, 22, -44, 44, -66, 66, -88, 88, -110, 110];

// Greedy placement: walk candidate positions along the route and return the first
// one whose label rect hits nothing. `rects` are obstacles, `lines` are other routes.
// Returns { x, y, rect, clear } where x/y go straight into the edge's mxGeometry.
export function placeLabel(
  route,
  size,
  { rects = [], lines = [], fractions = DEFAULT_FRACTIONS, offsets = DEFAULT_OFFSETS } = {},
) {
  let best = null;
  for (const f of fractions) {
    for (const o of offsets) {
      const rx = +(2 * f - 1).toFixed(3);
      const rect = labelRect(route, rx, o, size);
      let cost = 0;
      for (const ob of rects) cost += rectOverlap(rect, ob);
      for (const ln of lines) if (routeCrossesRect(ln, rect)) cost += 4000;
      if (!cost) return { x: rx, y: o, rect, clear: true };
      if (!best || cost < best.cost) best = { x: rx, y: o, rect, cost, clear: false };
    }
  }
  return best;
}
