/**
 * Кейс help-004: снимки и схемы документа «Тесты» (`/help?topic=tests`)
 * загружаются в обеих темах — ни одной битой картинки, ни одного ответа 4xx/5xx
 * на изображение.
 *
 * Тема меняется настоящей настройкой панели (PATCH /api/settings, как её пишет
 * раздел «Настройки»), затем страница перезагружается. Картинки справки
 * ленивые, поэтому каждая прокручивается в видимую область и ждётся её
 * загрузка: `naturalWidth > 0` — браузер картинку действительно нарисовал.
 * Сеть слушается целиком: битый снимок, подменённый заглушкой, всё равно
 * виден по коду ответа.
 *
 * Запуск: `node tools/qa/check-help-images.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const THEMES = [
  ['light', 'Светлая'],
  ['dark', 'Тёмная'],
];

await runOnStand({ label: 'help-images' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    for (const [theme, label] of THEMES) {
      const saved = await stand.api('/settings', { method: 'PATCH', body: { theme } });
      check(`${label}: тема записана настройкой`, saved.status < 300, saved.text.slice(0, 200));
      const page = await stand.newPage(browser, { height: 900 });
      const bad = [];
      page.on('response', (res) => {
        const type = res.request().resourceType();
        if (type === 'image' && res.status() >= 400) bad.push(`${res.status()} ${res.url()}`);
      });
      page.on('requestfailed', (req) => {
        if (req.resourceType() === 'image') bad.push(`сбой ${req.url()}`);
      });
      await page.goto(`${stand.webUrl}/help?topic=tests`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
      await wait(500);
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      check(`${label}: страница в теме ${theme}`, applied === theme, String(applied));

      const images = page.locator('main img');
      const total = await images.count();
      for (let index = 0; index < total; index += 1) {
        await images
          .nth(index)
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await images
          .nth(index)
          .evaluate((img) =>
            img.complete && img.naturalWidth > 0
              ? undefined
              : new Promise((done) => {
                  img.addEventListener('load', done, { once: true });
                  img.addEventListener('error', done, { once: true });
                  setTimeout(done, 8000);
                }),
          )
          .catch(() => undefined);
      }
      const broken = await images.evaluateAll((nodes) =>
        nodes
          .filter((img) => !(img.complete && img.naturalWidth > 0))
          .map((img) => img.currentSrc || img.src),
      );
      console.log(
        `  ${label}: картинок ${total}, битых ${broken.length}, плохих ответов ${bad.length}`,
      );
      check(`${label}: в документе есть картинки (иначе проверять нечего)`, total > 0, `${total}`);
      check(`${label}: все картинки нарисованы`, broken.length === 0, broken.join('\n'));
      check(
        `${label}: ни одного ответа 4xx/5xx или сбоя на изображение`,
        bad.length === 0,
        bad.join('\n'),
      );
      check(
        `${label}: страница без необработанных ошибок`,
        page.errors.length === 0,
        page.errors.join(' | '),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
