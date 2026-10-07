#!/usr/bin/env node
/* global Image, document -- code inside page.evaluate() runs in the browser */
// figma-parity / Phase 5S — STRICT visual sweep compositor.
//
// Input : sweep/inventory.json  { pairs: [{ id, screen, kind, shot, figmaShot, figmaNode }] }
//         image paths relative to the inventory file (absolute also accepted).
// Output: sweep/<id>/{pair,overlay,heat}.png  +  sweep/pairs.json
//
// Composites exist so the comparison agent sees both sides at one scale instead of guessing
// alignment. heat.png / attentionOnly_hotBlocksPct are an ATTENTION MAP — where to look. They are
// never a verdict and never a parity score (references/scoring.md).
//
// Pure Node + optional Playwright (all pixel work runs in a headless canvas). No Playwright →
// pairs.json is still written, composites are skipped, and the sweep proceeds on the raw images.
//
// Usage:
//   node visual-sweep.mjs [.agent/figma-parity/sweep/inventory.json] [--out DIR] [--width 900]
//                         [--no-heat] [--block 6] [--threshold 24]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const positional = argv.filter(
  (a, i) =>
    !a.startsWith('--') && !['--out', '--width', '--block', '--threshold'].includes(argv[i - 1]),
);

const invPath = resolve(positional[0] ?? '.agent/figma-parity/sweep/inventory.json');
if (!existsSync(invPath)) {
  console.error(`inventory not found: ${invPath}`);
  process.exit(1);
}
const invDir = dirname(invPath);
const outDir = resolve(flag('--out', invDir));
const WIDTH = Math.max(200, Number(flag('--width', 900)) || 900);
const BLOCK = Math.max(2, Number(flag('--block', 6)) || 6);
const THRESHOLD = Math.max(1, Number(flag('--threshold', 24)) || 24);
const wantHeat = !has('--no-heat');

const raw = JSON.parse(readFileSync(invPath, 'utf8'));
const pairs = Array.isArray(raw) ? raw : Array.isArray(raw.pairs) ? raw.pairs : [];
if (!pairs.length) {
  console.error('inventory has no pairs — nothing to compose');
  process.exit(1);
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const abs = (p) => (isAbsolute(p) ? p : resolve(invDir, p));
const uri = (p) => {
  const f = abs(p);
  if (!existsSync(f)) return null;
  return `data:${MIME[extname(f).toLowerCase()] ?? 'image/png'};base64,${readFileSync(f).toString('base64')}`;
};
const writePng = (file, dataUrl) =>
  writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));

// This file lives in the kit, not the project, so a bare import() never sees the PROJECT's node_modules —
// resolve from the cwd first, then fall back to the skill's own resolution.
async function launch() {
  const fromCwd = createRequire(resolve(process.cwd(), 'noop.js'));
  const errs = [];
  for (const mod of ['playwright', 'playwright-core', '@playwright/test']) {
    // CJS require first — dynamic import of these packages does not surface named exports.
    for (const load of [
      () => fromCwd(mod),
      () => import(pathToFileURL(fromCwd.resolve(mod)).href),
      () => import(mod),
    ]) {
      let chromium;
      try {
        const m = await load();
        chromium = m?.chromium ?? m?.default?.chromium;
      } catch {
        continue; // not resolvable this way
      }
      if (!chromium) continue;
      try {
        return await chromium.launch();
      } catch (e) {
        errs.push(`${mod}: ${e.message.split('\n')[0]}`); // resolved but cannot start (browser not installed?)
      }
    }
  }
  if (errs.length) console.warn(`playwright found but did not launch — ${errs[0]}`);
  return null;
}

// Runs inside the page: normalises both images to one width, then emits the three composites.
async function compose(page, a, b, opts) {
  return page.evaluate(
    async ([designSrc, frontSrc, o]) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error('decode failed'));
          i.src = src;
        });
      const [d, f] = await Promise.all([load(designSrc), load(frontSrc)]);

      // one scale for both: same width, height kept proportional
      const w = o.width;
      const norm = (img) => {
        const h = Math.max(1, Math.round((img.height / img.width) * w));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.imageSmoothingQuality = 'high';
        // Figma exports are often transparent — flatten both sides onto the same white so
        // transparency reads as canvas, not as a difference.
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, w, h);
        x.drawImage(img, 0, 0, w, h);
        return c;
      };
      const D = norm(d);
      const F = norm(f);
      const H = Math.max(D.height, F.height);
      const GAP = 16;
      const LABEL = 22;

      const sheet = (draw, cw, ch) => {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const x = c.getContext('2d');
        x.fillStyle = '#1c1c1a';
        x.fillRect(0, 0, cw, ch);
        draw(x);
        return c.toDataURL('image/png');
      };
      const label = (x, text, px) => {
        x.fillStyle = '#f0efec';
        x.font = '13px ui-sans-serif, system-ui, sans-serif';
        x.fillText(text, px, 15);
      };

      const pair = sheet(
        (x) => {
          x.drawImage(D, 0, LABEL);
          x.drawImage(F, w + GAP, LABEL);
          label(x, 'FIGMA', 0);
          label(x, 'FRONT', w + GAP);
        },
        w * 2 + GAP,
        H + LABEL,
      );

      const overlay = sheet(
        (x) => {
          x.drawImage(D, 0, LABEL);
          x.globalAlpha = 0.5;
          x.drawImage(F, 0, LABEL);
          x.globalAlpha = 1;
          label(x, 'FIGMA + FRONT 50%', 0);
        },
        w,
        H + LABEL,
      );

      let heat = null;
      let hot = null;
      if (o.heat) {
        const h = Math.min(D.height, F.height);
        const dp = D.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
        const fp = F.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
        const bx = Math.ceil(w / o.block);
        const by = Math.ceil(h / o.block);
        const cells = [];
        let hotCells = 0;
        for (let gy = 0; gy < by; gy++) {
          for (let gx = 0; gx < bx; gx++) {
            let sum = 0;
            let n = 0;
            for (let y = gy * o.block; y < Math.min((gy + 1) * o.block, h); y++) {
              for (let px = gx * o.block; px < Math.min((gx + 1) * o.block, w); px++) {
                const i = (y * w + px) * 4;
                sum +=
                  Math.abs(dp[i] - fp[i]) +
                  Math.abs(dp[i + 1] - fp[i + 1]) +
                  Math.abs(dp[i + 2] - fp[i + 2]);
                n += 3;
              }
            }
            const avg = n ? sum / n : 0;
            if (avg >= o.threshold) hotCells++;
            cells.push(avg);
          }
        }
        hot = cells.length ? Math.round((hotCells / cells.length) * 1000) / 10 : 0;
        heat = sheet(
          (x) => {
            x.globalAlpha = 0.35;
            x.drawImage(F, 0, LABEL);
            x.globalAlpha = 1;
            for (let i = 0; i < cells.length; i++) {
              const a = Math.min(1, cells[i] / 96);
              if (cells[i] < o.threshold) continue;
              x.fillStyle = `rgba(255,64,64,${a})`;
              x.fillRect(
                (i % bx) * o.block,
                LABEL + Math.floor(i / bx) * o.block,
                o.block,
                o.block,
              );
            }
            label(x, 'ATTENTION MAP — not a score', 0);
          },
          w,
          h + LABEL,
        );
      }

      return {
        pair,
        overlay,
        heat,
        hot,
        design: { w: d.width, h: d.height },
        front: { w: f.width, h: f.height },
        aspectDelta: Math.round(Math.abs(d.height / d.width - f.height / f.width) * 1000) / 1000,
      };
    },
    [a, b, opts],
  );
}

const browser = await launch();
if (!browser) {
  console.warn('playwright not importable — no composites; the sweep runs on the raw two images');
}
const page = browser ? await browser.newPage({ viewport: { width: 100, height: 100 } }) : null;
if (page) await page.setContent('<!doctype html><meta charset="utf-8"><title>sweep</title>');

const out = [];
let composed = 0;
const problems = [];

for (const p of pairs) {
  const rec = {
    id: p.id,
    screen: p.screen ?? null,
    kind: p.kind ?? 'screen',
    figmaNode: p.figmaNode ?? null,
  };
  const dUri = p.figmaShot ? uri(p.figmaShot) : null;
  const fUri = p.shot ? uri(p.shot) : null;
  rec.shot = p.shot ?? null;
  rec.figmaShot = p.figmaShot ?? null;
  if (!fUri) problems.push(`${p.id}: front shot missing (${p.shot ?? '—'})`);
  if (!dUri)
    problems.push(
      `${p.id}: figma shot missing (${p.figmaShot ?? '—'}) — compare against the spec table`,
    );

  if (page && dUri && fUri) {
    const dir = resolve(outDir, String(p.id));
    mkdirSync(dir, { recursive: true });
    try {
      const r = await compose(page, dUri, fUri, {
        width: WIDTH,
        block: BLOCK,
        threshold: THRESHOLD,
        heat: wantHeat,
      });
      writePng(resolve(dir, 'pair.png'), r.pair);
      writePng(resolve(dir, 'overlay.png'), r.overlay);
      rec.pair = `${p.id}/pair.png`;
      rec.overlay = `${p.id}/overlay.png`;
      if (r.heat) {
        writePng(resolve(dir, 'heat.png'), r.heat);
        rec.heat = `${p.id}/heat.png`;
        rec.attentionOnly_hotBlocksPct = r.hot;
      }
      rec.sizes = { design: r.design, front: r.front, aspectDelta: r.aspectDelta };
      composed++;
    } catch (e) {
      problems.push(`${p.id}: compose failed — ${e.message}`);
    }
  }
  out.push(rec);
}

if (browser) await browser.close();

mkdirSync(outDir, { recursive: true });
const pairsPath = resolve(outDir, 'pairs.json');
writeFileSync(
  pairsPath,
  JSON.stringify(
    {
      note: 'heat.png and attentionOnly_hotBlocksPct point at WHERE to look. They are not a verdict and not a parity score.',
      width: WIDTH,
      composed,
      total: pairs.length,
      pairs: out,
      problems,
    },
    null,
    2,
  ),
);

console.log(`pairs: ${pairs.length} · composed: ${composed} · ${pairsPath}`);
for (const x of problems) console.log(`  ! ${x}`);
if (composed < pairs.length)
  console.log(
    '  → every pair below N still gets compared; say so in the report instead of dropping it',
  );
