/**
 * Сборка руководства: .agent/chat-guide/index.html → docs/CHAT-GUIDE.ru.pdf.
 *
 * Печатает Chromium, потому что вёрстка страницы — обычный CSS с @page, и
 * никакого второго движка для этого держать не нужно. Кадры берутся с диска, из
 * соседней папки `shots/` (их снимает `tools/docs/shots-chat-guide.mjs`).
 *
 * Исходник и кадры лежат в рабочей папке агента, вне git: человеку отдаётся
 * готовый PDF, а полторы сотни мегабайт снимков репозиторию не нужны. В свежем
 * клоне пересборка начинается со съёмки кадров.
 *
 * `PAGES=<каталог>` вдобавок раскладывает каждую страницу картинкой — чтобы
 * посмотреть их глазами: пустых и полупустых страниц в отдаваемом PDF быть не должно.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE = resolve(process.env.SOURCE ?? '.agent/chat-guide/index.html');
const OUT = resolve(process.env.OUT ?? 'docs/CHAT-GUIDE.ru.pdf');

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(pathToFileURL(SOURCE).href, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:7pt;color:#5b6472;padding:0 12mm;text-align:right;font-family:Segoe UI,sans-serif">' +
    'Чат AgentDeck · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
});

console.log(`PDF: ${OUT}`);

// Постраничные картинки для просмотра глазами: печать даёт разбиение, которого
// в потоке страницы не видно, и только по кадрам понятно, где остался пробел.
if (process.env.PAGES) {
  const dir = resolve(process.env.PAGES);
  mkdirSync(dir, { recursive: true });
  const A4 = { width: 794, height: 1123 };
  const shotPage = await browser.newPage({ viewport: A4, deviceScaleFactor: 1 });
  await shotPage.goto(pathToFileURL(SOURCE).href, { waitUntil: 'networkidle' });
  await shotPage.emulateMedia({ media: 'print' });
  await shotPage.addStyleTag({
    content: `html{width:${A4.width}px}body{width:${A4.width - 91}px;margin:0 auto}`,
  });
  const height = await shotPage.evaluate(() => document.body.scrollHeight);
  const pages = Math.ceil(height / A4.height);
  for (let i = 0; i < pages; i += 1) {
    await shotPage.evaluate((y) => window.scrollTo(0, y), i * A4.height);
    await shotPage.waitForTimeout(120);
    await shotPage.screenshot({ path: join(dir, `page-${String(i + 1).padStart(2, '0')}.png`) });
  }
  console.log(`Страниц (приблизительно): ${pages} → ${dir}`);
}

await browser.close();
