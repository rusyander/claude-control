/**
 * Счётчик вкладки «Аналитика → Сессии» — за весь период, а не длина списка
 * последних (ревью 28.09, F-183): сервер отдаёт в списке только последние 25, и
 * за насыщенный период вкладка говорила «25».
 *
 * Ответ `/api/analytics` берётся со стенда и подправляется в браузере: список
 * последних — 25 записей, по проектам — 30 и 10 сессий, за период — 37: сессия,
 * писавшая в двух каталогах, в сумме по проектам считается дважды, поэтому
 * счётчик обязан брать поле периода. Число не зависит от того, сколько человек
 * наработал за сутки. Запросы только на чтение; любая
 * запись — 501.
 *
 * Запуск: `node tools/qa/check-analytics-session-count.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/analytics/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/analytics';
mkdirSync(SHOTS, { recursive: true });

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

const session = (index) => ({
  sessionId: `qa-session-${index}`,
  project: 'C:/qa-analytics',
  displayName: 'qa-analytics',
  startedAt: '2026-09-27T08:00:00.000Z',
  lastActivity: `2026-09-27T09:${String(index).padStart(2, '0')}:00.000Z`,
  totals: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 },
  estimatedCost: 0,
  models: ['claude-qa'],
  isActive: false,
});
const project = (name, sessions) => ({
  project: `C:/${name}`,
  displayName: name,
  totals: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 },
  estimatedCost: 0,
  sessions,
  lastActivity: '2026-09-27T09:00:00.000Z',
});

const browser = await chromium.launch();
const results = {};
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  const blocked = [];
  // Последняя подмена отвечает первой: сторож записи ставится первым.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  await page.route(/\/api\/analytics(\?.*)?$/, async (route) => {
    // Запрос может быть ещё в полёте, когда контекст уже закрыт, — не отказ проверки.
    const response = await route.fetch().catch(() => undefined);
    if (!response) return;
    const body = await response.json().catch(() => undefined);
    if (!body) return route.fulfill({ response }).catch(() => undefined);
    return route
      .fulfill({
        response,
        json: {
          ...body,
          recentSessions: Array.from({ length: 25 }, (_, index) => session(index)),
          byProject: [project('qa-a', 30), project('qa-b', 10)],
          periodSessions: 37,
        },
      })
      .catch(() => undefined);
  });
  await bypassOnboarding(page);
  await page.goto(`${BASE}/analytics?tab=sessions`, { waitUntil: 'domcontentloaded' });

  const tab = page.getByRole('tab', { name: /Сессии/ });
  await tab.waitFor({ timeout: 60_000 });
  await page
    .waitForFunction(
      () =>
        /\d/.test(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? ''),
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
  const text = (await tab.innerText()).replace(/\s+/g, ' ').trim();
  check(
    /\b37\b/.test(text),
    `${theme}: вкладка считает сессии за период — 37, а не сумму по проектам`,
    text,
  );
  const hint = await tab
    .locator('[title]')
    .first()
    .getAttribute('title')
    .catch(() => null);
  check(
    hint === 'Сессий за период: 37; в списке — последние 25',
    `${theme}: у числа подсказка, сколько показано в списке`,
    String(hint),
  );
  check(blocked.length === 0, `${theme}: записей не было`, blocked.join(', '));
  await page.screenshot({ path: `${SHOTS}/sessions-tab-${theme}_${PHASE}.png` });
  results[theme] = text;
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
