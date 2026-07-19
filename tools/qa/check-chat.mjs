/**
 * Сквозная проверка чата: новый разговор, ответ по мере генерации, созданные
 * файлы и их предпросмотр. Разговор идёт по-настоящему — через Claude Code,
 * поэтому прогон занимает минуту-другую.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'chat');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

await page
  .getByRole('button', { name: /Новый чат/ })
  .first()
  .click();
await page.waitForTimeout(400);

const input = page.locator('textarea[data-chat-input]');
await input.fill(
  'Создай в текущей папке файл page.html — страницу с заголовком и кнопкой, ' +
    'которая по клику меняет цвет фона. И файл notes.md с описанием в пару строк. ' +
    'Ответь одним предложением.',
);
await input.press('Enter');

// Пока идёт ответ, в ленте должна появиться и своя реплика, и текст модели.
await page.waitForTimeout(7000);
await page.screenshot({ path: join(OUT_DIR, '1-streaming.png') });

const artifacts = page.locator('[data-artifacts] button');
await artifacts.first().waitFor({ timeout: 300_000 });
await page.waitForTimeout(2000);

const names = await artifacts.allInnerTexts();
await page.screenshot({ path: join(OUT_DIR, '2-answer.png') });

// Предпросмотр страницы: содержимое рисуется во врезке.
await page.locator('[data-artifacts] button', { hasText: '.html' }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT_DIR, '3-preview-html.png') });

const frameContent = await page.frameLocator('iframe').locator('body').innerText();

// Вкладка с исходником — там же, рядом с предпросмотром.
await page.getByRole('button', { name: 'Исходник' }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT_DIR, '4-preview-source.png') });

// Разметка показывается как документ.
const markdownButton = page.locator('[data-artifacts] button', { hasText: '.md' }).first();
if (await markdownButton.count()) {
  await markdownButton.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, '5-preview-markdown.png') });
}

await browser.close();

console.log('Созданные файлы:', names.join(', ') || 'НЕТ');
console.log('Страница во врезке:', frameContent.trim() ? 'отрисована' : 'ПУСТО');
console.log(problems.length ? `\nПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : '\nОшибок консоли нет.');
