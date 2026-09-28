/**
 * Реестр проектов упал, а работать надо (ревью 28.09, F-194): раздел тестов
 * открывает первую из вкладок проектов, но запомненный проект реестра не
 * забывает — после «Повторить» открыт снова он, а не вкладка, подставленная на
 * время сбоя.
 *
 * Сервер подменён там, где касается проверочных проектов: `GET /api/projects`
 * отвечает 500, пока прогон не «починит» реестр; любой запрос с их каталогами —
 * 404; любая запись — 501. Стенд не пишется, конфигурация человека не трогается.
 *
 * Запуск: `node tools/qa/check-tests-registry-error.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/tests-registry/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/tests-registry';
mkdirSync(SHOTS, { recursive: true });

const TAB = { id: 'c:/qa-tab', name: 'QA вкладка', path: 'C:/qa-tab' };
const REMEMBERED = { id: 'qa-reg', name: 'QA реестр', path: 'C:/qa-reg' };
const STORAGE_KEY = 'agentdeck:tests-project';

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
// HMR Vite перезагрузил бы страницу посреди прогона, если рядом правят код.
const appPort = new URL(BASE).port;
await context.routeWebSocket(
  (url) => url.port === appPort && url.pathname === '/',
  () => undefined,
);
const page = await context.newPage();

let healed = false;
const blocked = [];
// Последняя подмена отвечает первой: сторож записи ставится первым.
await page.route('**/api/**', (route) => {
  const request = route.request();
  const url = decodeURIComponent(request.url()).toLowerCase();
  if (request.method() !== 'GET') {
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  }
  if (url.includes('qa-tab') || url.includes('qa-reg')) {
    return route.fulfill({ status: 404, json: { error: 'qa: проверочный проект' } });
  }
  return route.fallback();
});
await page.route('**/api/projects', (route) => {
  if (route.request().method() !== 'GET') return route.fallback();
  return healed
    ? route.fulfill({ json: [REMEMBERED] })
    : route.fulfill({ status: 500, json: { error: 'qa: реестр недоступен' } });
});
await bypassOnboarding(page);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  ([tab, remembered, key]) => {
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({ projectTabs: [tab], activeTabId: tab.id, views: {} }),
    );
    localStorage.setItem(key, remembered.id);
  },
  [TAB, REMEMBERED, STORAGE_KEY],
);
await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });

const main = page.getByRole('main');
const partial = main.getByText('Реестр проектов не загрузился');
const hasPartial = await partial
  .waitFor({ timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
check(hasPartial, 'реестр упал — раздел говорит, что список неполный');
const tabShown = await main
  .getByText(TAB.path, { exact: true })
  .first()
  .waitFor({ timeout: 8_000 })
  .then(() => true)
  .catch(() => false);
check(tabShown, 'на время сбоя открыт проект из вкладки, а не пустой раздел');
await page.screenshot({ path: `${SHOTS}/registry-failed_${PHASE}.png` });

healed = true;
await page
  .locator('[role="status"]')
  .filter({ hasText: 'Реестр проектов не загрузился' })
  .getByRole('button', { name: 'Повторить' })
  .click();
await partial.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
const back = await main
  .getByText(REMEMBERED.path, { exact: true })
  .first()
  .waitFor({ timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check(
  back,
  'после «Повторить» открыт запомненный проект реестра, а не вкладка',
  (await main.innerText().catch(() => '')).includes(TAB.path) ? TAB.path : '',
);
const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
check(stored === REMEMBERED.id, 'память выбора не переписана сбоем', String(stored));
await page.screenshot({ path: `${SHOTS}/registry-healed_${PHASE}.png` });
check(blocked.length === 0, 'записей не было', blocked.join(', '));

await browser.close();
console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
