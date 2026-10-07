#!/usr/bin/env node
// Render every page of a .drawio to PNG, plus one PDF of all pages when the draw.io CLI exists.
// Usage: node shots.mjs <file.drawio> <outDir>
// Renderer autodetect: draw.io CLI (PNG per page + PDF) → headless Chrome/Edge over
// viewer.diagrams.net (PNG only, needs network). Exit 0 = every page rendered.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('usage: node shots.mjs <file.drawio> <outDir>');
  process.exit(2);
}
const xml = readFileSync(file, 'utf8');
mkdirSync(outDir, { recursive: true });

const pages = [...xml.matchAll(/<diagram\b([^>]*)>/g)].map((m, i) => {
  const n = /name="([^"]*)"/.exec(m[1]);
  return n ? n[1] : `page${i + 1}`;
});
if (!pages.length) {
  console.error('no <diagram> pages found');
  process.exit(1);
}

function findExe(cands) {
  for (const c of cands) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else if (spawnSync(c, ['--version'], { timeout: 5000 }).status === 0) return c;
  }
  return null;
}

const drawio = findExe([
  'C:\\Program Files\\draw.io\\draw.io.exe',
  'C:\\Program Files (x86)\\draw.io\\draw.io.exe',
  '/Applications/draw.io.app/Contents/MacOS/draw.io',
  'drawio',
  'draw.io',
]);

let pngs = 0;
if (drawio) {
  pages.forEach((name, i) => {
    const out = resolve(outDir, `page-${i + 1}.png`);
    const r = spawnSync(
      drawio,
      [
        '--export',
        '--format',
        'png',
        '--page-index',
        String(i),
        '--scale',
        '2',
        '--output',
        out,
        file,
      ],
      { stdio: 'ignore', timeout: 120000 },
    );
    if (r.status === 0 && existsSync(out)) {
      pngs++;
      console.log(`page-${i + 1}.png <- ${name}`);
    } else console.error(`page-${i + 1}: draw.io export failed (status ${r.status})`);
  });
  const pdf = resolve(outDir, basename(file).replace(/\.drawio$/i, '') + '.pdf');
  const r = spawnSync(
    drawio,
    ['--export', '--format', 'pdf', '--all-pages', '--output', pdf, file],
    { stdio: 'ignore', timeout: 120000 },
  );
  if (r.status === 0 && existsSync(pdf)) console.log(`${basename(pdf)} (all pages)`);
  else console.error('PDF export failed — report the PDF as not produced');
} else {
  const chrome = findExe([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ]);
  if (!chrome) {
    console.error('no draw.io CLI and no Chrome/Edge found — cannot render, say so in the report');
    process.exit(1);
  }
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  pages.forEach((name, i) => {
    const cfg = JSON.stringify({ xml, page: i, toolbar: '', nav: false, resize: true, border: 20 });
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#ffffff}</style></head>
<body><div class="mxgraph" data-mxgraph="${esc(cfg)}"></div>
<script src="https://viewer.diagrams.net/js/viewer.min.js"></script></body></html>`;
    const hp = resolve(outDir, `page-${i + 1}.html`);
    writeFileSync(hp, html);
    const png = resolve(outDir, `page-${i + 1}.png`);
    const r = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1.5',
        '--window-size=2600,1800',
        '--virtual-time-budget=15000',
        `--screenshot=${png}`,
        'file:///' + hp.replace(/\\/g, '/'),
      ],
      { stdio: 'ignore', timeout: 60000 },
    );
    if (r.status === 0 && existsSync(png)) {
      pngs++;
      console.log(`page-${i + 1}.png <- ${name}`);
    } else console.error(`page-${i + 1}: screenshot failed`);
    rmSync(hp, { force: true });
  });
  console.error('PDF: needs the draw.io CLI — not produced');
}
console.log(`rendered ${pngs}/${pages.length} page(s)`);
process.exit(pngs === pages.length ? 0 : 1);
