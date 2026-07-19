/**
 * Сквозная проверка помощника: открыть форму правила, попросить сформулировать
 * правило словами и убедиться, что поля заполнились. Ничего не сохраняет.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'forms');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 120)}`);
});

await page.goto(`${BASE_URL}/rules`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.getByRole('button', { name: /Добавить правило/i }).click();
await page.waitForSelector('[role="dialog"]');
await page
  .locator('[role="dialog"]')
  .evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));

const hasChat = await page.getByText('Помощник').isVisible();
console.log('Панель помощника видна:', hasChat ? 'да' : 'НЕТ');

await page.screenshot({ path: join(OUT_DIR, 'assistant-empty.png') });

// Просим сформулировать правило и ждём ответ модели.
await page.getByLabel('Помощник').fill('Правило: не коммитить без прогона линта');
await page.getByRole('button', { name: 'Отправить' }).click();
console.log('Запрос отправлен, ждём ответ…');

await page
  .waitForFunction(
    () => (document.querySelector('#\\:r0\\:, [aria-label="Заголовок"]')?.value ?? '') !== '',
    { timeout: 180_000 },
  )
  .catch(() => undefined);

// Даём ответу дорисоваться и снимаем результат.
await page.waitForTimeout(2000);
const titleValue = await page.getByLabel('Заголовок').inputValue();
const bodyValue = await page.getByLabel('Текст правила').inputValue();

await page.screenshot({ path: join(OUT_DIR, 'assistant-filled.png') });

console.log('Заголовок заполнен:', titleValue ? `«${titleValue}»` : 'НЕТ');
console.log('Текст заполнен:', bodyValue ? `${bodyValue.length} символов` : 'НЕТ');

await browser.close();
console.log(problems.length ? `ПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : 'Ошибок консоли нет.');
