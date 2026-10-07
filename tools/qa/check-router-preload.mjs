/**
 * Гонка предзагрузки роутера (Ф24): ссылка в фокусе запускает предзагрузку
 * раздела (`defaultPreload: 'intent'`), а щелчок по ней приходит, пока чанк
 * раздела ещё грузится. До @tanstack/router-core 1.171.34 переход вытеснял
 * кэшированное совпадение предзагрузки, и та падала в консоль необработанным
 * `Cannot read properties of undefined (reading '_nonReactive')`
 * (TanStack/router#7759).
 *
 * Гоняется по живому стенду (`pnpm dev`, :8888) и ничего на нём не пишет:
 * ответ настроек подменяется только в браузере (`bypassOnboarding`). Чанки
 * разделов (`/src/pages/…` дев-сервера Vite) задерживаются на `DELAY` мс, чтобы
 * щелчок гарантированно попадал в середину предзагрузки; каждый раздел — с
 * чистого документа, иначе модуль уже в памяти и гонки нет.
 *
 * Код выхода 1 — в консоли была ошибка `_nonReactive` или ни одного перехода
 * не случилось (проверка, которая ничего не прошла, — не зелёная).
 *
 * Запуск: node tools/qa/check-router-preload.mjs [--passes N]   (браузеры: pnpm qa:setup)
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { PANEL_PAGES } from './panel-pages.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const DELAY = Number(process.env.DELAY ?? 800);
const passesAt = process.argv.indexOf('--passes');
const PASSES = passesAt >= 0 ? Math.max(1, Number(process.argv[passesAt + 1]) || 1) : 1;

const browser = await chromium.launch();
const page = await browser.newPage();
await bypassOnboarding(page);
await page.route(/\/src\/pages\//, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, DELAY));
  await route.continue();
});
const errors = [];
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

// Разделы с адресом — те же, что обходят a11y и клавиатура; корень — точка старта.
// Вкладки (`?tab=`, `#`) ссылок в меню не имеют — у них нечего предзагружать фокусом.
const paths = [...new Set(PANEL_PAGES.map((entry) => entry.path))].filter(
  (path) => path !== '/' && !/[?#]/.test(path),
);
let rounds = 0;
const skipped = [];
for (let pass = 0; pass < PASSES; pass += 1) {
  for (const path of paths) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav a[href]');
    // Чанки стартового экрана догружаются — иначе щелчок ждал бы их, а не предзагрузку.
    await page.waitForTimeout(DELAY * 2);
    const link = page.locator(`nav a[href="${path}"]`).first();
    if ((await link.count()) === 0) {
      if (pass === 0) skipped.push(path);
      continue;
    }
    // Фокус запускает предзагрузку; щелчок — на её середине (второй проход — позже).
    await link.focus();
    await page.waitForTimeout((DELAY / 4) * (pass + 1));
    await link.click();
    await page.waitForURL((url) => url.pathname === path, { timeout: DELAY * 10 });
    await page.waitForTimeout(DELAY * 2);
    rounds += 1;
  }
}
await browser.close();

const race = errors.filter((text) => text.includes('_nonReactive'));
console.log(
  `Переходов в середине предзагрузки: ${rounds} (проходов ${PASSES}, задержка чанков ${DELAY} мс)`,
);
if (skipped.length > 0) console.log(`Нет ссылки в меню: ${skipped.join(', ')}`);
console.log(`Ошибок консоли: ${errors.length}, из них «_nonReactive»: ${race.length}`);
for (const text of errors.slice(0, 5)) console.log(`  ${text.split('\n')[0].slice(0, 200)}`);
if (rounds === 0) {
  console.log('ПРОВАЛ: ни одного перехода — проверять было нечего.');
  process.exit(1);
}
if (race.length > 0) {
  console.log('ПРОВАЛ: гонка предзагрузки роутера в консоли.');
  process.exit(1);
}
console.log('OK: консоль без ошибки предзагрузки.');
