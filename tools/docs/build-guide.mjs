/**
 * Печать руководства: HTML-исходник → PDF в `docs/`.
 *
 * Печатает Chromium, потому что вёрстка страницы — обычный CSS с @page, и
 * никакого второго движка для этого держать не нужно. Кадры берутся с диска, из
 * соседней папки `shots/` рядом с исходником (их снимает свой `shots-*.mjs`).
 *
 * Исходники и кадры лежат в рабочей папке агента, вне git: человеку отдаётся
 * готовый PDF, а сотни мегабайт снимков репозиторию не нужны. В свежем клоне
 * пересборка начинается со съёмки кадров.
 *
 * Общий на все руководства: своё у каждого — только путь исходника, путь PDF и
 * подпись в колонтитуле. Отдельные `build-chat-guide.mjs` и
 * `build-tests-guide.mjs` — это те самые три значения и ничего больше.
 *
 * `PAGES=<каталог>` вдобавок раскладывает каждую страницу картинкой — чтобы
 * посмотреть их глазами: пустых и полупустых страниц в отдаваемом PDF быть не должно.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Печать одного руководства.
 *
 * @param {object} options
 * @param {string} options.source путь к HTML-исходнику
 * @param {string} options.out путь к готовому PDF
 * @param {string} [options.footer] подпись в колонтитуле; пусто — из <title>
 * @param {string} [options.pages] каталог для постраничных картинок
 * @returns {Promise<{out: string, pages: number}>}
 */
export async function buildGuide({ source, out, footer, pages }) {
  const sourcePath = resolve(source);
  const outPath = resolve(out);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });

  // Подпись колонтитула по умолчанию — название документа до тире: заголовок
  // «Чат AgentDeck — руководство» внизу каждой страницы не нужен целиком.
  const label = footer ?? (await page.title()).split('—')[0].trim();

  await page.pdf({
    path: outPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:7pt;color:#5b6472;padding:0 12mm;text-align:right;font-family:Segoe UI,sans-serif">' +
      `${escapeHtml(label)} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
  });

  console.log(`PDF: ${outPath}`);

  // Постраничные картинки для просмотра глазами: печать даёт разбиение, которого
  // в потоке страницы не видно, и только по кадрам понятно, где остался пробел.
  let count = 0;
  if (pages) {
    const dir = resolve(pages);
    mkdirSync(dir, { recursive: true });
    const A4 = { width: 794, height: 1123 };
    const shotPage = await browser.newPage({ viewport: A4, deviceScaleFactor: 1 });
    await shotPage.goto(pathToFileURL(sourcePath).href, { waitUntil: 'networkidle' });
    await shotPage.emulateMedia({ media: 'print' });
    await shotPage.addStyleTag({
      content: `html{width:${A4.width}px}body{width:${A4.width - 91}px;margin:0 auto}`,
    });
    const height = await shotPage.evaluate(() => document.body.scrollHeight);
    count = Math.ceil(height / A4.height);
    for (let i = 0; i < count; i += 1) {
      await shotPage.evaluate((y) => window.scrollTo(0, y), i * A4.height);
      await shotPage.waitForTimeout(120);
      await shotPage.screenshot({ path: join(dir, `page-${String(i + 1).padStart(2, '0')}.png`) });
    }
    console.log(`Страниц (приблизительно): ${count} → ${dir}`);
  }

  await browser.close();
  return { out: outPath, pages: count };
}

/** Подпись уходит в HTML колонтитула, поэтому кавычки и угловые скобки экранируются. */
function escapeHtml(text) {
  return text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
  );
}

// Запуск напрямую: всё задаётся окружением, дефолтов у общего сборщика нет.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SOURCE || !process.env.OUT) {
    console.error(
      'Нужны SOURCE и OUT: SOURCE=.agent/<guide>/index.html OUT=docs/<GUIDE>.ru.pdf ' +
        'node tools/docs/build-guide.mjs',
    );
    process.exit(1);
  }
  await buildGuide({
    source: process.env.SOURCE,
    out: process.env.OUT,
    footer: process.env.FOOTER,
    pages: process.env.PAGES,
  });
}
