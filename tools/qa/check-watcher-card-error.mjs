/**
 * Состояние наблюдателя не прочиталось (ревью 28.09, F-302): карточка в
 * «Настройки → Общие» говорит почему и даёт «Повторить», а не стоит с
 * выключенным тумблером без единого слова.
 *
 * `GET /api/watcher` отвечает 500, пока прогон не «починит» его; после
 * «Повторить» — живым состоянием «выключен». Любая запись — 501: наблюдатель
 * не включается, конфигурация человека не трогается.
 *
 * Запуск: `node tools/qa/check-watcher-card-error.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/watcher-card/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/watcher-card';
mkdirSync(SHOTS, { recursive: true });

const REASON = 'qa: наблюдатель недоступен';
const STATUS = {
  enabled: false,
  since: '2026-09-27T10:00:00.000Z',
  serverNow: '2026-09-27T10:01:00.000Z',
  analyzing: false,
  pending: 0,
  findings: 0,
  remarks: 0,
  thresholds: { slowRequestMs: 5000, stuckLoadingMs: 30_000 },
  hourlyCap: { limit: 12, used: 0 },
  spend: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, runs: 0, estimatedUsd: 0 },
  reportPath: 'C:/qa/WATCH-REPORT.md',
};

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
  let healed = false;
  const blocked = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  await page.route(/\/api\/watcher(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return healed
      ? route.fulfill({ json: STATUS })
      : route.fulfill({ status: 500, json: { error: REASON } });
  });
  await bypassOnboarding(page);
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('[data-watcher-card]');
  await card.waitFor({ timeout: 60_000 });

  const alert = card.getByRole('alert').filter({ hasText: REASON });
  const named = await alert
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check(named, `${theme}: сбой чтения назван в карточке`, (await card.innerText()).slice(0, 200));
  const retry = card.getByRole('button', { name: 'Повторить' });
  const hasRetry = await retry.isVisible().catch(() => false);
  check(hasRetry, `${theme}: рядом «Повторить»`);
  await card.screenshot({ path: `${SHOTS}/status-failed-${theme}_${PHASE}.png` });

  if (hasRetry) {
    healed = true;
    await retry.click();
    const toggle = card.getByRole('switch');
    const live = await page
      .waitForFunction(
        () => {
          const element = document.querySelector('[data-watcher-card] [role="switch"]');
          return element && !element.hasAttribute('disabled');
        },
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(
      live && (await alert.count()) === 0,
      `${theme}: после «Повторить» тумблер живой, сбоя больше нет`,
      `тумблер ${(await toggle.isDisabled().catch(() => true)) ? 'заперт' : 'живой'}`,
    );
  }
  check(blocked.length === 0, `${theme}: записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
