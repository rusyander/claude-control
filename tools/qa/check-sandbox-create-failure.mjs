/**
 * Песочница не создалась (ревью 28.09, F-176): окно говорит почему и даёт
 * «Повторить», а не стоит с выключенными кнопками прогона без объяснения.
 *
 * Запись закрыта целиком: POST /api/sandbox/create отвечает подменённым отказом
 * (второй — другой причиной, так видно, что «Повторить» спросил заново), DELETE
 * песочницы — подменённым «ок». Со стенда читается только список скиллов, так
 * что прогон ничего не создаёт и не трогает конфигурацию человека.
 *
 * Запуск: `node tools/qa/check-sandbox-create-failure.mjs` при поднятом
 * `pnpm dev` (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER`
 * — суффикс снимков в `.agent/screenshots/before-after/nits-N3/sandbox/`.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/sandbox';
mkdirSync(SHOTS, { recursive: true });

const REASONS = ['нет места на диске', 'каталог песочницы занят'];
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
    viewport: { width: 1500, height: 950 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  const creates = [];
  // До «Повторить» — первая причина: в разработке StrictMode открывает окно
  // дважды, и запросов на открытие бывает два.
  let retried = false;
  const blocked = [];
  // Последняя подмена отвечает первой: сторож записи ставится первым.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  await page.route('**/api/sandbox/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/sandbox/create') {
      const reason = retried ? REASONS[1] : REASONS[0];
      creates.push(reason);
      return route.fulfill({ status: 500, json: { error: reason } });
    }
    if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    return route.fallback();
  });
  await bypassOnboarding(page);
  await page.goto(`${BASE}/skills`, { waitUntil: 'domcontentloaded' });
  const open = page.getByRole('button', { name: /Песочница:/ }).first();
  await open.waitFor({ timeout: 60_000 });
  await open.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10_000 });
  const alert = dialog.getByRole('alert').filter({ hasText: REASONS[0] });
  await alert.waitFor({ timeout: 8_000 }).catch(() => undefined);
  check(await alert.isVisible().catch(() => false), `${theme}: причина сбоя названа в окне`);
  const retry = dialog.getByRole('button', { name: 'Повторить' });
  const hasRetry = await retry.isVisible().catch(() => false);
  check(hasRetry, `${theme}: рядом «Повторить»`);
  await page.screenshot({ path: `${SHOTS}/create-failed-${theme}_${PHASE}.png` });
  if (hasRetry) {
    const before = creates.length;
    retried = true;
    await retry.click();
    const second = dialog.getByRole('alert').filter({ hasText: REASONS[1] });
    await second.waitFor({ timeout: 8_000 }).catch(() => undefined);
    check(
      creates.length === before + 1 && (await second.isVisible().catch(() => false)),
      `${theme}: «Повторить» спрашивает сервер заново и показывает новый ответ`,
      `запросов: ${creates.length}`,
    );
  }
  check(
    (await page.getByText(REASONS[0]).count()) <= 1,
    `${theme}: причина не повторена общим тостом`,
  );
  check(blocked.length === 0, `${theme}: иных записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
