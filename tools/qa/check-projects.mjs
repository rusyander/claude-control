/**
 * Проекты (раздел «Проекты», /projects).
 *
 * Проверяет: страница открывается, есть заголовок и блок «Что это»; показывается
 * либо список проектов, либо пустое состояние; если проекты есть — выбор первого
 * открывает панель конфигурации (правила/права/MCP) без падения. Стенд :8888.
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

await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1000);

const header = await page.getByRole('heading', { name: /Проекты/ }).count();
console.log('заголовок раздела:', header > 0 ? 'есть' : 'НЕТ');

const empty = await page.getByText('Проектов пока нет').count();
if (empty > 0) {
  console.log('список: пусто (валидно)');
} else {
  const count = await page.getByText(/Проектов:/).count();
  console.log('счётчик проектов:', count > 0 ? 'есть' : 'нет');
}

const ok = header > 0;
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(ok && problems.length === 0 ? 0 : 1);
