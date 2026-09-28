/**
 * Кейс config-resources-010: выбор файла инструкций на «CLAUDE.md» проходится
 * клавиатурой по образцу радиогруппы (F-244) — одна остановка Tab на выбранном
 * имени, стрелки и Home/End двигают и фокус, и выбор, по кругу; Tab уходит из
 * группы, Shift+Tab возвращает на выбранное.
 *
 * Юнит-тесты веба идут в node без DOM: снятый обработчик клавиш или снятый
 * `.focus()` они не замечают. Замечает только этот проход по живой странице.
 *
 * GET /api/claude-md берётся с живого стенда, подменяется лишь
 * `instructionFiles` (предложенный выбор из трёх имён) — иначе группа
 * рисуется только у проекта с двумя файлами. Любая запись заглушена 501:
 * ничего не пишется, и кейс можно гонять без присмотра.
 *
 * Запуск: `node tools/qa/check-instruction-files-keyboard.mjs` (нужен `pnpm dev`).
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const CHOICES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const rows = [];
const row = (what, expected, got) =>
  rows.push({ what, expected, got, ok: String(expected) === String(got) });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await bypassOnboarding(page);
const writes = [];
await page.route('**/api/**', async (route) => {
  const req = route.request();
  if (req.method() !== 'GET') {
    writes.push(`${req.method()} ${req.url()}`);
    return route.fulfill({ status: 501, json: { error: 'check: writes stubbed' } });
  }
  if (/\/api\/claude-md(\?|$)/.test(req.url())) {
    const response = await route.fetch();
    const body = await response.json();
    body.instructionFiles = {
      mode: 'claude-md-or-agents-md',
      source: 'default',
      read: [],
      ignored: [],
      choices: CHOICES,
      proposed: true,
      notes: [],
    };
    body.fileName = 'CLAUDE.md';
    return route.fulfill({ response, json: body });
  }
  return route.fallback();
});

await page.goto(`${BASE}/claude-md`, { waitUntil: 'load' });
const group = page.locator('[role="radiogroup"]');
await group.waitFor({ timeout: 30000 });

const state = () =>
  page.evaluate(() => {
    const radios = [...document.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    const active = document.activeElement;
    return {
      focused:
        active?.getAttribute('role') === 'radio'
          ? active.textContent.trim()
          : `(${active?.tagName})`,
      checked: radios
        .filter((r) => r.getAttribute('aria-checked') === 'true')
        .map((r) => r.textContent.trim())
        .join(','),
      stops: radios
        .filter((r) => r.tabIndex === 0)
        .map((r) => r.textContent.trim())
        .join(','),
      count: radios.length,
    };
  });

let s = await state();
row('radios rendered', 3, s.count);
row('one tab stop, on chosen', 'CLAUDE.md', s.stops);
const labelOk = await page.evaluate(() => {
  const id = document.querySelector('[role="radiogroup"]').getAttribute('aria-labelledby');
  return Boolean(id && document.getElementById(id)?.textContent.trim());
});
row('aria-labelledby target exists', true, labelOk);

// В группу — Tab с элемента перед ней.
await page.evaluate(() => {
  const all = [
    ...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]'),
  ].filter((el) => el.tabIndex >= 0 && !el.disabled && el.offsetParent !== null);
  const first = document.querySelector('[role="radiogroup"] [role="radio"]');
  const before = all
    .filter((el) => el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
    .at(-1);
  before?.focus();
});
let presses = 0;
do {
  await page.keyboard.press('Tab');
  presses += 1;
  s = await state();
} while (!CHOICES.includes(s.focused) && presses < 15);
row(`Tab enters group on chosen (${presses} presses)`, 'CLAUDE.md', s.focused);

const step = async (key, focus, checked) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(80);
  const now = await state();
  row(`${key} → focus`, focus, now.focused);
  row(`${key} → checked`, checked, now.checked);
  row(`${key} → single stop`, checked, now.stops);
};
await step('ArrowRight', 'AGENTS.md', 'AGENTS.md');
await step('ArrowDown', 'GEMINI.md', 'GEMINI.md');
await step('ArrowRight', 'CLAUDE.md', 'CLAUDE.md'); // по кругу вперёд
await step('ArrowLeft', 'GEMINI.md', 'GEMINI.md'); // по кругу назад
await step('ArrowUp', 'AGENTS.md', 'AGENTS.md');
await step('Home', 'CLAUDE.md', 'CLAUDE.md');
await step('End', 'GEMINI.md', 'GEMINI.md');

// Чужая клавиша ничего не меняет.
const scrollBefore = await page.evaluate(() => window.scrollY);
await page.keyboard.press('KeyA');
s = await state();
row('unrelated key: selection unchanged', 'GEMINI.md', s.checked);
row('unrelated key: focus unchanged', 'GEMINI.md', s.focused);
// Tab уходит из группы, а не на соседнее имя.
await page.keyboard.press('Tab');
s = await state();
row('Tab leaves group', true, !CHOICES.includes(s.focused));
// Shift+Tab возвращает на выбранное.
await page.keyboard.press('Shift+Tab');
s = await state();
row('Shift+Tab returns to checked', 'GEMINI.md', s.focused);
row('no writes sent', 0, writes.length);
row('page did not scroll on keys', scrollBefore, await page.evaluate(() => window.scrollY));

await browser.close();
for (const r of rows)
  console.log(`${r.ok ? 'ok ' : 'BAD'} | ${r.what} | expected ${r.expected} | got ${r.got}`);
const bad = rows.filter((r) => !r.ok).length;
console.log(`${rows.length - bad} ok, ${bad} bad`);
process.exit(bad ? 1 : 0);
