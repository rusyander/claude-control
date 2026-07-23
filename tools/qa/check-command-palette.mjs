/**
 * Командная палитра (Ctrl/Cmd+K, глобально).
 *
 * Проверяет: по Ctrl+K открывается диалог-палитра (combobox с фокусом в поле);
 * ввод названия раздела даёт опции навигации; ↓ + Enter переходит в раздел;
 * повторное Ctrl+K и Escape закрывают. Живой стенд (:8888).
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await bypassOnboarding(page); // убрать модалку онбординга
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(500);

// Поле палитры адресуем по имени — на страницах есть свои combobox (select'ы),
// поэтому «есть ли палитра» проверяем именно по её полю.
const palette = page.getByRole('combobox', { name: 'Командная палитра' });

// Открытие по Ctrl+K.
await page.keyboard.press('Control+k');
await palette.waitFor({ state: 'visible', timeout: 5000 });
const focused = await palette.evaluate((el) => el === document.activeElement);
console.log('палитра открыта, фокус в поле:', focused ? 'да' : 'НЕТ');

// Ввод названия раздела → нечёткий поиск по навигации даёт опции.
await palette.fill('настрой');
await page.waitForTimeout(400);
const listbox = page.getByRole('listbox');
const optCount = await listbox.getByRole('option').count();
console.log('опций навигации по «настрой»:', optCount);

// ↓ + Enter — переход в первый вариант.
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
const navigated = page.url().endsWith('/settings') && (await palette.count()) === 0;
console.log('после Enter: палитра закрыта и произошёл переход:', navigated ? 'да' : 'нет');

// Escape закрывает.
await page.keyboard.press('Control+k');
await palette.waitFor({ state: 'visible', timeout: 5000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const closed = (await palette.count()) === 0;
console.log('Escape закрывает палитру:', closed ? 'да' : 'НЕТ');

const ok = focused && optCount > 0 && navigated && closed;
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(ok && problems.length === 0 ? 0 : 1);
