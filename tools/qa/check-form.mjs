/**
 * Проверка диалога создания правила: открывается ли, работают ли поля,
 * ловится ли фокус. Ничего не сохраняет — CLAUDE.md пользователя не трогаем.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'forms');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.goto(`${BASE_URL}/rules`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

await page.getByRole('button', { name: /Добавить правило/i }).click();
await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

// Печатаем в поля, чтобы убедиться, что они управляемые и принимают ввод.
await page.getByLabel('Заголовок').fill('Проверочное правило (не сохраняем)');
await page.getByLabel('Текст правила').fill('Строка один\nСтрока два');

// Ждём конца анимации появления: иначе на снимке окно полупрозрачное,
// и это легко принять за сломанный фон.
await page
  .locator('[role="dialog"]')
  .evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));

await page.screenshot({ path: join(OUT_DIR, 'rule-form.png') });

const titleValue = await page.getByLabel('Заголовок').inputValue();
const isSaveEnabled = await page.getByRole('button', { name: /^Сохранить$/ }).isEnabled();

// Escape должен закрывать окно — это поведение Radix, проверяем что не сломано.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const isDialogClosed = (await page.locator('[role="dialog"]').count()) === 0;

await browser.close();

console.log('Поле заголовка принимает ввод:', titleValue.length > 0 ? 'да' : 'НЕТ');
console.log('Кнопка «Сохранить» активна:', isSaveEnabled ? 'да' : 'НЕТ');
console.log('Escape закрывает окно:', isDialogClosed ? 'да' : 'НЕТ');
console.log(problems.length ? `ПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : 'Ошибок консоли нет.');
