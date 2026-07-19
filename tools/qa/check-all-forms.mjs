/**
 * Открывает форму создания в каждом разделе, где она есть, и делает снимок.
 * Ничего не сохраняет: проверяем только, что окна открываются и рисуются,
 * и что рядом с полями есть панель помощника.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'forms');
mkdirSync(OUT_DIR, { recursive: true });

const CASES = [
  ['rule', '/rules', /Добавить правило/i],
  ['skill', '/skills', /Создать скилл/i],
  ['hook', '/hooks', /Добавить хук/i],
  ['script', '/scripts', /Добавить скрипт/i],
  ['mcp', '/mcp', /Добавить сервер/i],
  ['permission', '/permissions', /Добавить правило/i],
  ['env', '/env', /Добавить переменную/i],
  ['group', '/groups', /Создать группу/i],
  ['automation', '/groups', /Создать сценарий/i],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const problems = [];

for (const [name, path, buttonPattern] of CASES) {
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${name}] console: ${message.text()}`);
  });

  try {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await page.getByRole('button', { name: buttonPattern }).first().click();
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Ждём конца анимации появления, иначе снимок выйдет полупрозрачным.
    await page
      .locator('[role="dialog"]')
      .evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));

    const heading = await page.locator('[role="dialog"] h3').first().innerText();

    // Помощник должен быть в каждой форме — узнаём его по полю ввода запроса.
    const hasAssistant = await page
      .locator('[role="dialog"] textarea[data-assistant-input]')
      .count();
    if (hasAssistant === 0) problems.push(`[${name}] нет панели помощника`);

    await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
    console.log(
      `${name.padEnd(11)} OK — «${heading}»${hasAssistant ? ' + помощник' : ' БЕЗ ПОМОЩНИКА'}`,
    );
  } catch (error) {
    problems.push(`[${name}] ${error.message.split('\n')[0]}`);
    console.log(`${name.padEnd(11)} ОШИБКА`);
  }

  await page.close();
}

await browser.close();

console.log(problems.length ? `\nПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : '\nОшибок консоли нет.');
