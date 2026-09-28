/**
 * Секрет без значения и сбой дочитывания (ревью 28.09, F-224).
 *
 * Агент панели заводит секрет без значения и открывает форму, чтобы значение
 * ввёл человек. Сохранить её пустой — не ошибка: значения не было и нет, а
 * форма падала «Не удалось прочитать сохранённое значение» по-русски, даже в
 * английском интерфейсе. Сбой дочитывания НАСТОЯЩЕГО секрета остаётся отказом,
 * но словами на языке интерфейса.
 *
 * Сервер подменён: список переменных, дочитывание (пустой ответ) и запись.
 * Остальные записи — 501, настройки панели читаются со стенда, язык подменён.
 * Файлы человека не трогаются.
 *
 * Запуск: `node tools/qa/check-env-empty-secret.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/env/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/env';
mkdirSync(SHOTS, { recursive: true });

const EMPTY = {
  id: 'secrets:QA_EMPTY_TOKEN',
  key: 'QA_EMPTY_TOKEN',
  value: '',
  isSecret: true,
  source: 'secrets',
};
const MASKED = {
  id: 'secrets:QA_MASKED_TOKEN',
  key: 'QA_MASKED_TOKEN',
  value: 'glp•••••ab',
  isSecret: true,
  source: 'secrets',
};

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

const browser = await chromium.launch();
for (const language of ['ru', 'en']) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const appPort = new URL(BASE).port;
  // HMR Vite перезагрузил бы страницу посреди прогона, если рядом правят код.
  await context.routeWebSocket(
    (url) => url.port === appPort && url.pathname === '/',
    () => undefined,
  );
  const page = await context.newPage();
  const posts = [];
  const reveals = [];
  const blocked = [];
  // Последняя подмена отвечает первой: сторож записи ставится первым.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  await page.route(/\/api\/env(\/[a-z-]+)?(\?.*)?$/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/env') {
      return route.fulfill({ json: [EMPTY, MASKED] });
    }
    if (request.method() === 'GET' && path === '/api/env/reveal') {
      reveals.push(new URL(request.url()).searchParams.get('key'));
      return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    }
    if (request.method() === 'POST' && path === '/api/env') {
      posts.push(request.postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  // Язык — той же подменой настроек, что обходит мастер: второй маршрут её отменил бы.
  await bypassOnboarding(page, { language });
  await page.goto(`${BASE}/env`, { waitUntil: 'domcontentloaded' });

  const edit = (key) => page.locator(`button[aria-label$=": ${key}"]`).first();
  const dialog = page.getByRole('dialog');
  const saveLabel = language === 'en' ? 'Save' : 'Сохранить';

  // Позитив: пустой секрет, оставленный пустым, сохраняется без дочитывания.
  await edit(EMPTY.key).waitFor({ timeout: 30_000 });
  await edit(EMPTY.key).click();
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole('button', { name: saveLabel, exact: true }).click();
  const closed = await dialog
    .waitFor({ state: 'detached', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const posted = posts.find((body) => body.key === EMPTY.key);
  check(
    closed && posted?.value === '' && !reveals.includes(EMPTY.key),
    `${language}: пустой секрет сохранён пустым, без дочитывания и без отказа`,
    closed
      ? `запись ${JSON.stringify(posted ?? null)}`
      : (await dialog.innerText().catch(() => '')).slice(-160),
  );
  if (!closed) {
    await page.screenshot({ path: `${SHOTS}/empty-secret-${language}_${PHASE}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }

  // Негатив: настоящий секрет не дочитался — отказ словами на языке интерфейса.
  await edit(MASKED.key).click();
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole('button', { name: saveLabel, exact: true }).click();
  const expected =
    language === 'en'
      ? `Could not read the saved value of ${MASKED.key}`
      : `Не удалось прочитать сохранённое значение ${MASKED.key}`;
  const refusal = await dialog
    .getByText(expected)
    .first()
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  check(
    refusal && !posts.some((body) => body.key === MASKED.key),
    `${language}: сбой дочитывания — отказ на языке интерфейса, пустота не записана`,
    refusal ? '' : (await dialog.innerText().catch(() => '')).slice(-160),
  );
  await page.screenshot({ path: `${SHOTS}/reveal-failed-${language}_${PHASE}.png` });
  check(blocked.length === 0, `${language}: иных записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
