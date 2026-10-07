#!/usr/bin/env node
// figma-parity → self-contained side-by-side evidence report.
// Images are embedded here so their bytes never enter the model context.
//
//   node build-report.mjs [manifest.json] [--out report.html] [--standalone] [--max-bytes N]
//
// Default manifest: .agent/figma-parity/report.json (paths inside it are relative to it).
// Default output is an ARTIFACT FRAGMENT (<title> + <style> + markup, no doctype/html/body) —
// publishable via the Artifact tool as-is. --standalone wraps it for opening from disk.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !['--out', '--max-bytes'].includes(argv[i - 1]),
);

const manifestPath = resolve(positional[0] ?? '.agent/figma-parity/report.json');
if (!existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath}`);
  process.exit(1);
}
const baseDir = dirname(manifestPath);
const outPath = resolve(flag('--out', resolve(baseDir, 'report.html')));
const standalone = has('--standalone');
const maxBytes = Number(flag('--max-bytes', 25 * 1024 * 1024));

let m;
try {
  m = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`manifest is not valid JSON: ${e.message}`);
  process.exit(1);
}
const screens = Array.isArray(m.screens) ? m.screens : [];
if (!screens.length) {
  console.error('manifest has no screens[] — nothing to report');
  process.exit(1);
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};
const missing = [];
let embeddedBytes = 0;
const cache = new Map();

function dataUri(rel) {
  if (!rel) return null;
  if (cache.has(rel)) return cache.get(rel);
  const p = resolve(baseDir, rel);
  if (!existsSync(p) || !statSync(p).isFile()) {
    missing.push(rel);
    cache.set(rel, null);
    return null;
  }
  const mime = MIME[extname(p).toLowerCase()];
  if (!mime) {
    missing.push(`${rel} (unsupported type)`);
    cache.set(rel, null);
    return null;
  }
  const buf = readFileSync(p);
  embeddedBytes += buf.length;
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  cache.set(rel, uri);
  return uri;
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const STATUS = {
  ok: { label: '1:1 confirmed', cls: 'ok' },
  decisions: { label: 'decisions are yours', cls: 'warn' },
  blocked: { label: 'blocked', cls: 'bad' },
  partial: { label: 'partial', cls: 'warn' },
};

function img(rel, alt) {
  const uri = dataUri(rel);
  if (!uri) return `<div class="ph">no image<br><span>${esc(rel ?? '—')}</span></div>`;
  return `<img loading="lazy" src="${uri}" alt="${esc(alt)}">`;
}

function comparison(s, idx) {
  const figma = dataUri(s.figma);
  const front = dataUri(s.front);
  if (!figma && !front) return '';
  if (!figma || !front) {
    // One side unavailable — show what exists, spec table carries the verdict.
    return `<div class="pair one">
      <figure>${img(s.figma, 'Figma mock')}<figcaption>Figma mock</figcaption></figure>
      <figure>${img(s.front, 'our front')}<figcaption>Our front</figcaption></figure>
    </div>`;
  }
  return `<div class="cmp" data-cmp="${idx}" data-mode="side">
    <div class="modes" role="group" aria-label="comparison mode">
      <button data-set="side" class="on">Side by side</button>
      <button data-set="overlay">Overlay</button>
      <button data-set="blink">Blink</button>
    </div>
    <div class="pair">
      <figure><img loading="lazy" src="${figma}" alt="Figma mock"><figcaption>Figma mock</figcaption></figure>
      <figure><img loading="lazy" src="${front}" alt="our front"><figcaption>Our front</figcaption></figure>
    </div>
    <div class="stack">
      <img class="under" src="${figma}" alt="Figma mock">
      <img class="over" src="${front}" alt="our front">
      <span class="tag l">Figma</span><span class="tag r">Front</span>
    </div>
    <input class="slide" type="range" min="0" max="100" value="50" aria-label="comparison slider">
  </div>`;
}

function strip(title, items, kind) {
  if (!Array.isArray(items) || !items.length) return '';
  const cells = items
    .map((it) => {
      const shots = [
        ['Figma', it.figma],
        ['front', it.front],
        ['frames', it.strip],
      ].filter(([, p]) => p);
      const body = shots
        .map(
          ([cap, p]) =>
            `<div class="cell">${img(p, `${it.label ?? ''} — ${cap}`)}<span>${cap}</span></div>`,
        )
        .join('');
      const values =
        it.figma_value || it.front_value
          ? `<div class="vals"><code>${esc(it.figma_value ?? '—')}</code> → <code>${esc(it.front_value ?? '—')}</code></div>`
          : '';
      const mark =
        it.ok === false
          ? '<span class="chip bad">mismatch</span>'
          : it.ok === true
            ? '<span class="chip ok">match</span>'
            : '';
      return `<div class="strip-item"><h4>${esc(it.label ?? kind)} ${mark}</h4>${values}<div class="shots">${body}</div></div>`;
    })
    .join('');
  return `<details class="block" open><summary>${esc(title)}</summary><div class="strips">${cells}</div></details>`;
}

function decisions(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list
    .map(
      (d, i) => `<tr>
      <td>${esc(d.n ?? i + 1)}</td>
      <td>${esc(d.element)}</td>
      <td><code>${esc(d.figma)}</code></td>
      <td><code>${esc(d.front)}</code></td>
      <td>${esc(d.kind)}</td>
      <td class="rec ${d.recommend === 'FIX' ? 'fix' : d.recommend === 'NO FIX' ? 'nofix' : 'back'}">${esc(d.recommend)}</td>
      <td>${esc(d.why)}</td>
    </tr>`,
    )
    .join('');
  return `<details class="block" open><summary>For your decision — ${list.length}</summary>
    <div class="scroll"><table>
      <thead><tr><th>#</th><th>Element</th><th>Figma</th><th>Front</th><th>Type</th><th>Recommendation</th><th>Why</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></details>`;
}

function fixedSummary(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const chips = list
    .map((f) => `<span class="chip">${esc(f.category)} · ${esc(f.count)}</span>`)
    .join('');
  return `<div class="fixed"><b>Fixed automatically:</b> ${chips}</div>`;
}

function notes(list, cls, label) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="notes ${cls}"><b>${esc(label)}</b><ul>${list.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
}

const isColor = (v) => /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(String(v ?? '').trim());

function noTokenBlock(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const colors = list.filter((x) => isColor(x.value));
  const palette = colors.length
    ? `<div class="palette">${colors
        .map(
          (c) =>
            `<div class="sw"><span style="background:${esc(c.value)}"></span><code>${esc(c.value)}</code>${
              c.figmaVariable ? `<em>${esc(c.figmaVariable)}</em>` : ''
            }</div>`,
        )
        .join('')}</div>`
    : '';
  const rows = list
    .map(
      (
        x,
      ) => `<tr><td>${isColor(x.value) ? `<i class="dot" style="background:${esc(x.value)}"></i>` : ''}<code>${esc(x.value)}</code></td>
      <td>${esc(x.kind ?? '')}</td><td>${esc(x.element ?? '')}</td><td><code>${esc(x.where ?? '')}</code></td>
      <td>${esc(x.figmaVariable ?? '—')}</td></tr>`,
    )
    .join('');
  return `<section class="scr" id="no-token"><header><h2>No tokens — values taken from the mock</h2>
    <span class="badge warn">${list.length}</span>
    <div class="meta"><span>value taken from Figma as is, no project variable found — decide which ones deserve a variable</span></div></header>
    ${palette}
    <div class="scroll"><table><thead><tr><th>Value</th><th>What</th><th>Element</th><th>Applied at</th><th>Figma variable</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function snappedBlock(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list
    .map(
      (x) =>
        `<tr><td>${esc(x.category ?? '')}</td><td><code>${esc(x.figma)}</code></td><td><code>${esc(x.applied)}</code></td><td>${esc(x.why ?? '')}</td><td>${esc(x.where ?? '')}</td></tr>`,
    )
    .join('');
  return `<section class="scr" id="snapped"><header><h2>Snapped to the mock's semantics</h2>
    <span class="badge warn">${list.length}</span>
    <div class="meta"><span>the mock value breaks its own scale — the dominant one was applied; if it was deliberate, say so and it goes back</span></div></header>
    <div class="scroll"><table><thead><tr><th>What</th><th>In Figma</th><th>Applied</th><th>Why</th><th>Where</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function iconsBlock(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list
    .map(
      (x) =>
        `<tr><td><code>${esc(x.name)}</code></td><td>${esc(x.node ?? '')}</td><td>${esc(x.screens ?? '')}</td><td><code>${esc(x.where ?? '')}</code></td></tr>`,
    )
    .join('');
  return `<section class="scr" id="icons"><header><h2>Icons not found — placeholders in place</h2>
    <span class="badge warn">${list.length}</span>
    <div class="meta"><span>geometry and colour per the mock, the glyph is temporary — switch to the icons page in Figma to export the assets</span></div></header>
    <div class="scroll"><table><thead><tr><th>Name in Figma</th><th>Node</th><th>Screens</th><th>Placeholder at</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

const SWEEP_ST = {
  ok: { label: 'match', cls: 'ok' },
  fixed: { label: 'fixed', cls: 'warn' },
  escalated: { label: 'for decision', cls: 'bad' },
  unmapped: { label: 'no pair in the mock', cls: 'bad' },
  'no-figma': { label: 'no mock image', cls: 'warn' },
};

// STRICT sweep (references/strict-sweep.md). Images embedded only for pairs that are not ok —
// N clean side-by-sides as data URIs would blow --max-bytes for nothing.
function sweepBlock(sw) {
  if (!sw || typeof sw !== 'object') return '';
  const pairs = Array.isArray(sw.pairs) ? sw.pairs : [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const full = n(sw.compared) === n(sw.total) && n(sw.total) > 0;
  const chips = [
    `<span class="chip ${full ? 'ok' : 'bad'}">compared ${esc(sw.compared ?? '?')}/${esc(sw.total ?? '?')}</span>`,
    `<span class="chip">confirmed ${n(sw.confirmed)}</span>`,
    `<span class="chip ok">fixed ${n(sw.fixed)}</span>`,
    n(sw.escalated) ? `<span class="chip bad">for decision ${n(sw.escalated)}</span>` : '',
    n(sw.falsePositives)
      ? `<span class="chip warn">false positives ${n(sw.falsePositives)}</span>`
      : '',
    sw.rounds ? `<span class="chip">rounds ${esc(sw.rounds)}</span>` : '',
  ].join('');

  const rows = pairs
    .map((p) => {
      const st = SWEEP_ST[p.status] ?? { label: p.status ?? '—', cls: 'warn' };
      const shots =
        p.status && p.status !== 'ok'
          ? [img(p.pair, `${p.id} — mock and front`), img(p.heat, `${p.id} — attention map`)]
              .filter(Boolean)
              .join('')
          : '';
      return `<tr><td><code>${esc(p.id ?? '')}</code></td><td>${esc(p.screen ?? '')}</td><td>${esc(p.kind ?? '')}</td>
        <td>${esc(p.figmaNode ?? '—')}</td><td><span class="badge ${st.cls}">${esc(st.label)}</span></td>
        <td>${esc(p.found ?? '')}${shots ? `<div class="sweepshots">${shots}</div>` : ''}</td></tr>`;
    })
    .join('');

  const unmapped = (sw.unmapped ?? []).length
    ? `<div class="notes bad"><b>No pair in the mock — nothing to compare with:</b> ${sw.unmapped
        .map((u) => `${esc(u.id)} — ${esc(u.why ?? '')}`)
        .join(' · ')}</div>`
    : '';
  const fp = (sw.falsePositiveRows ?? []).length
    ? `<details class="fp"><summary>False positives of the visual sweep — ${sw.falsePositiveRows.length}</summary>
       <table><thead><tr><th>Pair</th><th>What it "saw"</th><th>Refuted by</th></tr></thead><tbody>${sw.falsePositiveRows
         .map(
           (f) =>
             `<tr><td><code>${esc(f.pair ?? '')}</code></td><td>${esc(f.claim ?? '')}</td><td><code>${esc(f.refutedBy ?? '')}</code></td></tr>`,
         )
         .join('')}</tbody></table></details>`
    : '';

  return `<section class="scr" id="sweep"><header><h2>Strict sweep: every captured shot against the mock</h2>
    ${chips}
    <div class="meta"><span>the image comparison looks for what numbers miss (extra/missing, block order, glyph, clipping, text); every finding is confirmed by a measurement — unconfirmed ones are dropped</span>
    ${sw.cappedOut ? '<span>hit the 3-round cap — the sweep did not converge, see the rows for decision</span>' : ''}</div></header>
    ${unmapped}
    <div class="scroll"><table><thead><tr><th>Pair</th><th>Screen</th><th>What</th><th>Node</th><th>Result</th><th>Mismatch</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${fp}</section>`;
}

function askBlock(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<section class="scr" id="ask-figma"><header><h2>Open in Figma — needed, but the page was not switched</h2>
    <span class="badge warn">${list.length}</span></header>
    <ul class="asks">${list.map((a) => `<li><b>${esc(a.page)}</b> — ${esc(a.why)}${a.screens ? ` <span class="dim">(${esc(a.screens)})</span>` : ''}</li>`).join('')}</ul></section>`;
}

const cards = screens
  .map((s, i) => {
    const st = STATUS[s.status] ?? { label: s.status ?? 'no status', cls: 'warn' };
    const sc = s.score;
    const scoreChip = sc
      ? `<span class="chip ${Number(sc.pct) >= 98 ? 'ok' : 'bad'}" title="matched checks of the total">${esc(sc.pct)}% properties · ${esc(sc.matched)}/${esc(sc.total)}</span>`
      : '';
    const structChip = (s.decisions ?? []).length
      ? `<span class="chip bad">structural open: ${(s.decisions ?? []).length}</span>`
      : '';
    const meta = [
      s.figmaNode && `node ${s.figmaNode}`,
      s.url,
      s.viewport && `viewport ${s.viewport}`,
      s.iterations && `iterations ${s.iterations}`,
    ]
      .filter(Boolean)
      .map((x) => `<span>${esc(x)}</span>`)
      .join('');
    return `<section class="scr" id="s-${i}">
      <header>
        <h2>${esc(s.name ?? `Screen ${i + 1}`)}</h2>
        <span class="badge ${st.cls}">${esc(st.label)}</span>
        ${scoreChip}${structChip}
        <div class="meta">${meta}</div>
      </header>
      ${s.blockedReason ? `<div class="notes bad"><b>Why blocked:</b> ${esc(s.blockedReason)}</div>` : ''}
      ${comparison(s, i)}
      ${fixedSummary(s.autoFixed)}
      ${strip('States', s.states, 'state')}
      ${strip('Motion', s.motion, 'animation')}
      ${strip('Data and edge cases', s.data, 'case')}
      ${decisions(s.decisions)}
      ${notes(s.legit, 'legit', 'Legitimate differences — not fixed:')}
      ${notes(s.unverified, 'warn', 'Not verified, and why:')}
      ${notes(s.notes, '', 'Notes:')}
    </section>`;
  })
  .join('\n');

const counts = screens.reduce(
  (a, s) => ((a[s.status ?? 'partial'] = (a[s.status ?? 'partial'] ?? 0) + 1), a),
  {},
);
const totalFixed = screens.reduce(
  (a, s) => a + (s.autoFixed ?? []).reduce((x, f) => x + (Number(f.count) || 0), 0),
  0,
);
const totalDec = screens.reduce((a, s) => a + (s.decisions ?? []).length, 0);
const scored = screens.filter((s) => s.score && Number.isFinite(Number(s.score.pct)));
const worst = scored.length ? Math.min(...scored.map((s) => Number(s.score.pct))) : null;
const totalChecks = scored.reduce((a, s) => a + (Number(s.score.total) || 0), 0);

const nav =
  screens
    .map((s, i) => {
      const st = STATUS[s.status] ?? { cls: 'warn' };
      return `<a href="#s-${i}" class="${st.cls}">${esc(s.name ?? `Screen ${i + 1}`)}</a>`;
    })
    .join('') +
  (m.sweep
    ? `<a href="#sweep" class="${Number(m.sweep.compared) === Number(m.sweep.total) ? 'ok' : 'bad'}">strict sweep · ${m.sweep.compared ?? '?'}/${m.sweep.total ?? '?'}</a>`
    : '') +
  [
    [m.noToken, '#no-token', 'no tokens'],
    [m.snapped, '#snapped', 'snapped'],
    [m.iconsMissing, '#icons', 'icons'],
    [m.askFigma, '#ask-figma', 'open in Figma'],
  ]
    .filter(([l]) => Array.isArray(l) && l.length)
    .map(([l, href, label]) => `<a href="${href}" class="warn">${label} · ${l.length}</a>`)
    .join('');

const title = m.title ?? 'Parity: front ↔ Figma';
const head = [
  m.mode && `mode ${m.mode}`,
  m.scale && `scale ${m.scale}`,
  m.date,
  m.gate && `gate: ${m.gate}`,
]
  .filter(Boolean)
  .map((x) => `<span>${esc(x)}</span>`)
  .join('');

const CSS = `
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e3e3e0;--card:#fff;--ok:#1a7f4b;--warn:#8a5a00;--bad:#a02c2c;--okbg:#e8f5ee;--warnbg:#fdf3e0;--badbg:#fbeaea;--code:#f2f2f0}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#f0efec;--dim:#a3a3a0;--line:#2e2e2c;--card:#1c1c1a;--ok:#6ecf9a;--warn:#e0b563;--bad:#e88b8b;--okbg:#16281f;--warnbg:#2a2214;--badbg:#2a1818;--code:#232321}}
:root[data-theme=light]{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e3e3e0;--card:#fff;--ok:#1a7f4b;--warn:#8a5a00;--bad:#a02c2c;--okbg:#e8f5ee;--warnbg:#fdf3e0;--badbg:#fbeaea;--code:#f2f2f0}
:root[data-theme=dark]{--bg:#141413;--fg:#f0efec;--dim:#a3a3a0;--line:#2e2e2c;--card:#1c1c1a;--ok:#6ecf9a;--warn:#e0b563;--bad:#e88b8b;--okbg:#16281f;--warnbg:#2a2214;--badbg:#2a1818;--code:#232321}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}
.wrap{max-width:1220px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:1.5rem;margin:0 0 6px}
.sub{color:var(--dim);font-size:.85rem;display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px}
.tot{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:26px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.nav a{font-size:.8rem;padding:4px 9px;border-radius:999px;text-decoration:none;color:var(--fg);border:1px solid var(--line);background:var(--card)}
.nav a.ok{border-color:var(--ok)}.nav a.warn{border-color:var(--warn)}.nav a.bad{border-color:var(--bad)}
.scr{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:22px}
.scr>header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}
.scr h2{font-size:1.1rem;margin:0}
.meta{flex:1 1 100%;color:var(--dim);font-size:.78rem;display:flex;flex-wrap:wrap;gap:12px}
.badge,.chip{font-size:.74rem;padding:3px 9px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.badge.ok,.chip.ok{background:var(--okbg);border-color:var(--ok);color:var(--ok)}
.badge.warn,.chip.warn{background:var(--warnbg);border-color:var(--warn);color:var(--warn)}
.badge.bad,.chip.bad{background:var(--badbg);border-color:var(--bad);color:var(--bad)}
.modes{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.modes button{font:inherit;font-size:.78rem;padding:4px 11px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.modes button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:780px){.pair{grid-template-columns:1fr}}
.pair figure{margin:0}
.pair img,.ph{width:100%;border:1px solid var(--line);border-radius:8px;display:block;background:var(--code)}
.pair img{max-height:78vh;object-fit:contain;object-position:top center;cursor:zoom-in}
.pair figcaption{margin-top:5px;font-size:.76rem;color:var(--dim);text-align:center}
.ph{padding:36px 12px;text-align:center;color:var(--dim);font-size:.8rem}
.ph span{font-size:.7rem;opacity:.7;word-break:break-all}
.stack{position:relative;display:none;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--code)}
.stack img{display:block;width:100%;max-height:78vh;object-fit:contain;object-position:top center}
.stack .under{cursor:zoom-in}
.stack .over{position:absolute;inset:0;height:100%;max-height:none;clip-path:inset(0 50% 0 0)}
.stack .tag{position:absolute;top:8px;font-size:.68rem;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.62);color:#fff}
.stack .tag.l{left:8px}.stack .tag.r{right:8px}
.slide{display:none;width:100%;margin-top:8px}
.cmp[data-mode=overlay] .pair,.cmp[data-mode=blink] .pair{display:none}
.cmp[data-mode=overlay] .stack,.cmp[data-mode=blink] .stack{display:block}
.cmp[data-mode=overlay] .slide{display:block}
.cmp[data-mode=blink] .over{clip-path:none;animation:blink 1.6s steps(1,end) infinite}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.cmp[data-mode=blink] .over{animation-duration:4s}}
.block{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
.block>summary{cursor:pointer;font-size:.85rem;font-weight:600}
.strips{display:flex;flex-direction:column;gap:14px;margin-top:12px}
.strip-item h4{margin:0 0 4px;font-size:.85rem;font-weight:600}
.vals{font-size:.78rem;color:var(--dim);margin-bottom:6px}
.shots{display:flex;gap:10px;flex-wrap:wrap}
.cell{flex:0 1 260px}
.cell img,.cell .ph{width:100%;border:1px solid var(--line);border-radius:6px;display:block}
.cell img{max-height:60vh;object-fit:contain;object-position:top center;cursor:zoom-in}
#zoom{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.86);display:none;overflow:auto;padding:20px;cursor:zoom-out}
#zoom.on{display:block}
#zoom img{display:block;margin:0 auto;max-width:none}
#zoom .hint{position:fixed;top:10px;left:50%;transform:translateX(-50%);color:#fff;font-size:.76rem;background:rgba(0,0,0,.6);padding:3px 10px;border-radius:6px}
.cell span{font-size:.7rem;color:var(--dim)}
.scroll{overflow-x:auto;margin-top:10px}
table{border-collapse:collapse;width:100%;font-size:.82rem;min-width:760px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.92em;word-break:break-word}
.rec{font-weight:600;white-space:nowrap}
.rec.fix{color:var(--bad)}.rec.nofix{color:var(--dim)}.rec.back{color:var(--warn)}
.fixed{margin-top:12px;font-size:.82rem;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.notes{margin-top:12px;font-size:.82rem;border-left:3px solid var(--line);padding:2px 0 2px 11px}
.notes.legit{border-color:var(--dim)}.notes.warn{border-color:var(--warn)}.notes.bad{border-color:var(--bad)}
.notes ul{margin:4px 0 0;padding-left:18px}
.palette{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.sw{display:flex;flex-direction:column;gap:3px;align-items:center;font-size:.72rem}
.sw span{width:58px;height:44px;border-radius:8px;border:1px solid var(--line);display:block}
.sw em{color:var(--dim);font-style:normal;font-size:.68rem}
.dot{display:inline-block;width:11px;height:11px;border-radius:3px;border:1px solid var(--line);margin-right:6px;vertical-align:-1px}
.sweepshots{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.sweepshots img{max-width:340px;width:100%;border:1px solid var(--line);border-radius:8px;cursor:zoom-in}
.fp{margin-top:12px;font-size:.82rem}
.fp summary{cursor:pointer;color:var(--dim)}
.fp table{margin-top:8px}
.asks{margin:6px 0 0;padding-left:20px;font-size:.85rem}
.asks li{margin-bottom:4px}
.dim{color:var(--dim)}
.foot{color:var(--dim);font-size:.76rem;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
`;

const JS = `
document.querySelectorAll('.cmp').forEach(function(c){
  c.querySelectorAll('.modes button').forEach(function(b){
    b.addEventListener('click',function(){
      c.dataset.mode=b.dataset.set;
      c.querySelectorAll('.modes button').forEach(function(x){x.classList.toggle('on',x===b)});
    });
  });
  var s=c.querySelector('.slide'),o=c.querySelector('.over');
  if(s&&o)s.addEventListener('input',function(){o.style.clipPath='inset(0 '+(100-s.value)+'% 0 0)'});
});
var z=document.getElementById('zoom'),zi=z.querySelector('img');
document.addEventListener('click',function(e){
  var t=e.target;
  if(t.tagName==='IMG'&&(t.closest('.pair')||t.closest('.cell')||t.closest('.sweepshots')||t.classList.contains('under'))){
    zi.src=t.currentSrc||t.src;zi.alt=t.alt||'';z.classList.add('on');
  } else if(z.classList.contains('on')){z.classList.remove('on');zi.removeAttribute('src')}
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&z.classList.contains('on')){z.classList.remove('on');zi.removeAttribute('src')}});
`;

const content = `<style>${CSS}</style>
<div class="wrap">
<h1>${esc(title)}</h1>
<div class="sub">${head}</div>
<div class="tot">
  <span class="chip ok">1:1 — ${counts.ok ?? 0}</span>
  <span class="chip warn">with decisions — ${(counts.decisions ?? 0) + (counts.partial ?? 0)}</span>
  <span class="chip bad">blocked — ${counts.blocked ?? 0}</span>
  <span class="chip">auto-fixes — ${totalFixed}</span>
  <span class="chip">for decision — ${totalDec}</span>
  ${scored.length ? `<span class="chip ${worst >= 98 ? 'ok' : 'bad'}">worst screen by properties — ${worst}%</span>` : ''}
  ${scored.length ? `<span class="chip">checks in total — ${totalChecks}</span>` : ''}
  ${m.sweep ? `<span class="chip ${Number(m.sweep.compared) === Number(m.sweep.total) ? 'ok' : 'bad'}">strict sweep — ${m.sweep.compared ?? '?'}/${m.sweep.total ?? '?'}</span>` : ''}
</div>
<nav class="nav">${nav}</nav>
${cards}
${sweepBlock(m.sweep)}
${noTokenBlock(m.noToken)}
${snappedBlock(m.snapped)}
${iconsBlock(m.iconsMissing)}
${askBlock(m.askFigma)}
<div id="zoom" role="dialog" aria-label="full size"><span class="hint">click or Esc — close</span><img alt=""></div>
<div class="foot">Click an image for full size. Image comparison is indicative (different viewports and font rendering). The verdict comes from numbers: computed styles against the Figma spec. ${missing.length ? `Files not found: ${missing.length}.` : ''}</div>
</div>
<script>${JS}</script>`;

const titleTag = `<title>${esc(title)}</title>`;
const out = standalone
  ? `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">${titleTag}</head>` +
    `<body>${content}</body></html>`
  : `${titleTag}\n${content}`;

writeFileSync(outPath, out, 'utf8');

const size = Buffer.byteLength(out, 'utf8');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log(
  `${outPath}  ${mb(size)}  screens:${screens.length}  images:${cache.size - missing.length}  embedded:${mb(embeddedBytes)}`,
);
if (missing.length)
  console.error(
    `missing images (${missing.length}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`,
  );
if (size > maxBytes) {
  console.error(
    `report is ${mb(size)} > limit ${mb(maxBytes)} — re-capture shots as JPEG q75 at <=1000px, or split the manifest per flow`,
  );
  process.exit(2);
}
