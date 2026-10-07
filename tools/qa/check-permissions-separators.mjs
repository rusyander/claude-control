/**
 * Строки «Разрешений» разделены линией (ревью 28.09, F-240). Разделитель висел
 * на `.row:not(:last-child)`, а список оборачивает каждую строку своей обёрткой —
 * строка всегда последняя в ней, и линий не было ни одной.
 *
 * Проверяется то, что нарисовано: у первой строки линии нет, у каждой
 * следующей — есть, и высота строки осталась 50px (место строки в списке —
 * меньшая или большая высота ставила строки внахлёст, bug 7).
 *
 * Только чтение со стенда: любая запись — 501.
 * Запуск: `node tools/qa/check-permissions-separators.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `PHASE=BEFORE|AFTER` — суффикс
 * снимков в `.agent/screenshots/before-after/nits-N3/permissions/`.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = process.env.PHASE ?? 'AFTER';
const SHOTS = '.agent/screenshots/before-after/nits-N3/permissions';
mkdirSync(SHOTS, { recursive: true });

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

/**
 * Строки для сверки — свои: проверка рисованная, а не про содержимое. Без
 * подмены список брался из настоящих настроек стенда, и на одноразовом стенде
 * (ни одного права) вторая строка не появлялась никогда.
 */
const RULES = [
  ['Bash(git status:*)', 'allow'],
  ['Bash(git push:*)', 'ask'],
  ['Read(./.env)', 'deny'],
  ['mcp__qa-tracker__get_issue', 'allow'],
].map(([pattern, decision], index) => ({
  id: `qa-${index}`,
  pattern,
  decision,
  ...(pattern.startsWith('mcp__') ? { mcpServer: 'qa-tracker', mcpTool: 'get_issue' } : {}),
  groupIds: [],
  source: 'settings',
  isEnabled: true,
}));

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  const blocked = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } });
  });
  // Поставлена после общей подмены — отвечает первой.
  await page.route(/\/api\/permissions(\?|$)/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: RULES }) : route.fallback(),
  );
  await bypassOnboarding(page);
  await page.goto(`${BASE}/permissions`, { waitUntil: 'domcontentloaded' });
  // Список прав — на вкладке «Все правила»; первой открыта «Системные».
  await page.getByText('Все правила', { exact: true }).first().click({ timeout: 60_000 });
  const rows = page.locator('main [data-agent-anchor]');
  await rows.nth(1).waitFor({ timeout: 60_000 });

  const drawn = await rows.evaluateAll((elements) =>
    elements.slice(0, 6).map((element) => {
      const style = getComputedStyle(element);
      const line =
        style.boxShadow.includes('inset') ||
        parseFloat(style.borderTopWidth) > 0 ||
        parseFloat(style.borderBottomWidth) > 0;
      return { line, height: Math.round(element.getBoundingClientRect().height) };
    }),
  );
  const [first, ...rest] = drawn;
  check(
    rest.length > 0 && rest.every((row) => row.line),
    `${theme}: между строками есть разделитель`,
    JSON.stringify(drawn),
  );
  // Линия — между строками: у первой её нет, иначе она легла бы на край карточки.
  check(first && !first.line, `${theme}: над первой строкой линии нет`, JSON.stringify(first));
  check(
    drawn.every((row) => row.height === 50),
    `${theme}: строка по-прежнему 50px — место строки в списке не разошлось`,
    drawn.map((row) => row.height).join(','),
  );
  const card = rows.first().locator('xpath=ancestor::*[contains(@class, "card")][1]');
  await ((await card.count()) ? card : page.locator('main'))
    .screenshot({ path: `${SHOTS}/rows-${theme}_${PHASE}.png` })
    .catch(() => page.screenshot({ path: `${SHOTS}/rows-${theme}_${PHASE}.png` }));
  check(blocked.length === 0, `${theme}: записей не было`, blocked.join(', '));
  await context.close();
}
await browser.close();

console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
