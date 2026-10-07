/* global window -- code inside page.evaluate() runs in the browser */
/**
 * Blank-space check on a PRINTED pdf, page by page.
 *
 * Why on the pdf and not on the source page: pagination is Chromium's, and it
 * moves `break-inside: avoid` blocks. Scrolling the html by page height reports
 * a layout the reader never gets.
 *
 * Per page it prints the share of rows carrying ink, total ink share and the
 * longest blank run. Thresholds of the rule: rows < 40% or a run > 1/3 page =
 * defect. `--png <dir>` also writes the pages as images — the numbers point,
 * the eyes decide.
 *
 * Deps: playwright (resolved from the current project first, then from this
 * folder), pdf.js (installed once into <tmp>/agentdeck-kit-deps — never into the kit itself).
 *
 * Usage: node <kit>/tools/pdf-blank-check.mjs <file.pdf> [--png <dir>] [--scale 1.2]
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
// `resolve('')` is the current directory, and it exists: a run without a path (or `--png out` with no
// file) passed this check and then failed inside the page with an opaque pdf.js error.
const target = args.find((value) => !value.startsWith('--') && value !== flag('--png'));
const PDF = target ? resolve(target) : '';
const PNG = flag('--png');
const SCALE = Number(flag('--scale') ?? 1.2);

if (!PDF || !existsSync(PDF) || statSync(PDF).isDirectory()) {
  console.error('no file: pass the path to a pdf');
  process.exit(2);
}
if (extname(PDF).toLowerCase() !== '.pdf') {
  console.error(`not a pdf: ${PDF}`);
  process.exit(2);
}

/** Playwright of the project being worked on wins: same browser build as its own runs. */
const loadPlaywright = async () => {
  for (const from of [join(process.cwd(), 'x.js'), join(HERE, 'x.js')]) {
    try {
      // playwright is CommonJS: named exports are not guaranteed, `default` is.
      const module = await import(pathToFileURL(createRequire(from).resolve('playwright')).href);
      const api = module.chromium ? module : module.default;
      if (api?.chromium) return api;
    } catch {
      /* next candidate */
    }
  }
  console.error('playwright not found: run from a project where it is installed');
  process.exit(2);
};

/** pdf.js lives in a temp deps dir; the first run pulls it in and every later one is offline. */
const DEPS = join(tmpdir(), 'agentdeck-kit-deps');
const pdfjsDir = join(DEPS, 'node_modules', 'pdfjs-dist');
if (!existsSync(join(pdfjsDir, 'build', 'pdf.min.mjs'))) {
  console.log('installing pdfjs-dist next to the tool (once)…');
  const install = spawnSync(
    'npm',
    ['i', 'pdfjs-dist@4.10.38', '--silent', '--no-audit', '--no-fund', '--prefix', DEPS],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (install.status !== 0) {
    console.error('install failed: install pdfjs-dist by hand into', DEPS);
    process.exit(2);
  }
}

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<canvas id="c"></canvas>
<script type="module">
import * as pdfjs from '/pdfjs/build/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.min.mjs';
const doc = await pdfjs.getDocument({ url: '/file.pdf' }).promise;
window.__pages = doc.numPages;
const draw = async (n, scale) => {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.getElementById('c');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, context };
};
window.__png = async (n, scale) => {
  const { canvas } = await draw(n, scale);
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
};
window.__ink = async (n) => {
  const { canvas, context } = await draw(n, 1);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  // Soft threshold: a light callout background is content too.
  const lit = (i) => data[i] < 246 || data[i + 1] < 246 || data[i + 2] < 246;
  let inked = 0;
  let gap = 0;
  let run = 0;
  let rows = 0;
  for (let y = 0; y < height; y += 1) {
    let rowInk = 0;
    for (let x = 0; x < width; x += 1) if (lit((y * width + x) * 4)) rowInk += 1;
    inked += rowInk;
    if (rowInk > width * 0.002) {
      rows += 1;
      run = 0;
    } else {
      run += 1;
      if (run > gap) gap = run;
    }
  }
  return { ink: inked / (width * height), rows: rows / height, gap: gap / height };
};
window.__ready = true;
</script></body>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.end(HTML);
    const path = url.pathname.startsWith('/pdfjs/')
      ? join(pdfjsDir, url.pathname.slice('/pdfjs/'.length))
      : PDF;
    const body = await readFile(path);
    response.setHeader(
      'content-type',
      extname(path) === '.pdf' ? 'application/pdf' : 'text/javascript',
    );
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end('missing');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('page error:', error.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60_000 });

if (PNG) mkdirSync(resolve(PNG), { recursive: true });

const total = await page.evaluate(() => window.__pages);
let bad = 0;
for (let n = 1; n <= total; n += 1) {
  const m = await page.evaluate((index) => window.__ink(index), n);
  const isLast = n === total;
  // The last page is allowed to be shorter, but not to be a stub.
  const defect = m.rows < (isLast ? 0.25 : 0.4) || m.gap > (isLast ? 0.45 : 0.33);
  if (defect) bad += 1;
  console.log(
    `${String(n).padStart(2, '0')}: rows ${(m.rows * 100).toFixed(0)}% · ink ${(m.ink * 100).toFixed(1)}% · gap ${(m.gap * 100).toFixed(0)}%${defect ? '  ← BLANK' : ''}`,
  );
  if (PNG) {
    const base64 = await page.evaluate(([index, scale]) => window.__png(index, scale), [n, SCALE]);
    writeFileSync(
      join(resolve(PNG), `page-${String(n).padStart(2, '0')}.png`),
      Buffer.from(base64, 'base64'),
    );
  }
}
console.log(bad === 0 ? `pages ${total}, none blank` : `pages ${total}, suspect: ${bad}`);

await browser.close();
server.close();
process.exit(bad === 0 ? 0 : 1);
