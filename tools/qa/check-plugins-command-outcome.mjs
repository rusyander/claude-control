/**
 * Итог команды над установленным плагином виден там, где её дали (ревью 28.09,
 * F-249). Тумблер, обновление и удаление живут на вкладке «Установленные», а
 * «нужен перезапуск» и вывод неудачной команды рисовались только в свёрнутой
 * форме установки на «Каталоге» — в двух щелчках и на другой вкладке.
 *
 * Сервер подменён целиком там, где касается плагинов: список с одним
 * установленным плагином и ответ тумблера (сначала успех, потом отказ с
 * выводом CLI). Любая иная запись — 501; CLI и `~/.claude` не трогаются.
 *
 * Запуск: `node tools/qa/check-plugins-command-outcome.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/plugins/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/plugins';
mkdirSync(SHOTS, { recursive: true });

const PLUGIN = {
  id: 'qa-plugin@qa-market',
  name: 'qa-plugin',
  marketplace: 'qa-market',
  version: '1.0.0',
  scope: 'user',
  isEnabled: true,
  isInstalled: true,
};
const RESTART = 'Изменения применятся после перезапуска Claude Code';
const FAILURE = 'qa: CLI отказал — плагин занят другим процессом';

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  const blocked = [];
  const toggles = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  await page.route(/\/api\/plugins(\/.*)?(\?.*)?$/, (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (request.method() === 'GET' && path === '/api/plugins') {
      return route.fulfill({
        json: { installed: [PLUGIN], available: [], marketplaces: [], notes: [] },
      });
    }
    if (request.method() === 'POST' && path === `/api/plugins/${PLUGIN.id}/enabled`) {
      toggles.push(request.postDataJSON());
      return toggles.length === 1
        ? route.fulfill({ json: { ok: true, output: 'disabled', needsRestart: true } })
        : route.fulfill({ json: { ok: false, output: FAILURE, needsRestart: false } });
    }
    return route.fallback();
  });
  await bypassOnboarding(page);
  await page.goto(`${BASE}/plugins?tab=installed`, { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  const toggle = main.getByRole('switch', { name: PLUGIN.name });
  await toggle.waitFor({ timeout: 60_000 });

  // Позитив: успешная команда — «нужен перезапуск» на той же вкладке.
  await toggle.click();
  const restart = await main
    .getByText(RESTART, { exact: true })
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(restart, `${theme}: после тумблера на «Установленных» видно «нужен перезапуск»`);
  await page.screenshot({ path: `${SHOTS}/toggle-ok-${theme}_${PHASE}.png` });

  // Негатив: отказ CLI — его вывод там же, а не только во всплывающем тосте.
  await toggle.click();
  const output = await main
    .getByText(FAILURE)
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(output, `${theme}: отказ команды — вывод CLI на «Установленных»`);
  check(
    (await main.getByText(RESTART, { exact: true }).count()) === 0,
    `${theme}: после отказа прежнее «нужен перезапуск» не висит`,
  );
  await page.screenshot({ path: `${SHOTS}/toggle-failed-${theme}_${PHASE}.png` });
  check(toggles.length === 2, `${theme}: тумблер дошёл до сервера дважды`, String(toggles.length));
  check(blocked.length === 0, `${theme}: иных записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
