/**
 * Полоса разделов страницы настроек: клик, адрес, клавиатура, роли.
 *
 * Ничего не пишет — только ходит по вкладкам, поэтому годится и на реальной
 * конфигурации. Нужен поднятый `pnpm dev`.
 *
 * Запуск: node tools/qa/check-settings-tabs.mjs
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const problems = [];

const ok = (name) => console.log(`  ок  ${name}`);

const bad = (name, detail) => {
  problems.push(`${name}: ${detail}`);
  console.log(`  !!  ${name} — ${detail}`);
};

/** Проверка одной строкой: прошло — «ок», иначе в список проблем. */
const expect = (passed, name, detail) => {
  if (passed) ok(name);
  else bad(name, detail);
};

const activeTab = (page) => page.locator('[role="tab"][aria-selected="true"]').textContent();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => bad('ошибка страницы', error.message));
await bypassOnboarding(page);
await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role="tablist"]');
await page.waitForTimeout(1200);

// 1. По умолчанию открыт первый раздел.
let now = await activeTab(page);
expect(now?.includes('Общие'), 'по умолчанию «Общие»', now ?? 'вкладка не выбрана');

// 2. Клик по вкладке меняет содержимое и адрес.
await page.getByRole('tab', { name: 'Расходы' }).click();
await page.waitForTimeout(500);
expect(page.url().includes('tab=spend'), 'клик пишет ?tab=spend', page.url());
expect(
  (await page.getByText('Тарифы для оценки стоимости').count()) > 0,
  'видна карточка тарифов',
  'карточка тарифов не найдена',
);
expect(
  (await page.getByText('Резервные копии').count()) === 0,
  'карточек чужих разделов нет',
  'карточка чужого раздела осталась на экране',
);

// 3. Стрелки ходят по вкладкам, Home/End — по краям.
await page.getByRole('tab', { name: 'Расходы' }).focus();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
now = await activeTab(page);
expect(now?.includes('Безопасность'), 'ArrowRight → «Безопасность»', now ?? '');

await page.keyboard.press('Home');
await page.waitForTimeout(300);
now = await activeTab(page);
expect(now?.includes('Общие'), 'Home → «Общие»', now ?? '');

await page.keyboard.press('End');
await page.waitForTimeout(300);
now = await activeTab(page);
expect(now?.includes('Перенос'), 'End → «Перенос»', now ?? '');

// 4. Только активная вкладка попадает в обход по Tab.
const focusable = await page.locator('[role="tab"][tabindex="0"]').count();
expect(focusable === 1, 'в обход по Tab входит одна вкладка', `фокусируемых вкладок: ${focusable}`);

// 5. Панель связана с вкладкой.
const panelId = await page.locator('[role="tabpanel"]').getAttribute('aria-labelledby');
const tabId = await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
expect(panelId === tabId, 'панель подписана вкладкой', `${panelId} ≠ ${tabId}`);

// 6. Прямая ссылка открывает раздел.
await page.goto(`${BASE_URL}/settings?tab=access`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
now = await activeTab(page);
expect(now?.includes('Доступ'), '?tab=access открывает «Доступ»', now ?? '');

// 7. Мусор в адресе не даёт пустого экрана.
await page.goto(`${BASE_URL}/settings?tab=nope`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
now = await activeTab(page);
expect(now?.includes('Общие'), 'неизвестный tab → «Общие»', now ?? '');

await browser.close();
console.log(problems.length ? `\nПроблем: ${problems.length}` : '\nПроблем нет');
process.exit(problems.length ? 1 : 0);
