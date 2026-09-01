/**
 * Проверка общего дерева файлов: один компонент должен работать и на скилле
 * (папка с вложенностью), и на скрипте (одиночный файл).
 */
import { chromium } from 'playwright';
import { apiFetch } from './api-auth.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
await page.emulateMedia({ colorScheme: 'dark' });

// Скилл: дерево с папками
await page.goto('http://localhost:8888/skills', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);
// Счётчик файлов зависит от того, что лежит в конфигурации проверяющего, поэтому
// берём первый скилл с непустым деревом, а не конкретное число.
await page
  .locator('button', { hasText: /^\d+ файл/ })
  .first()
  .click();
await page.waitForTimeout(2000);
const skillTree = await page.getByText('references', { exact: false }).count();
console.log('скилл — папки в дереве:', skillTree > 0 ? 'есть' : 'НЕТ');
await page.screenshot({ path: '.qa-screenshots/resources-skill.png' });

// Скрипт: тот же компонент на одиночном файле.
// Имя берётся из API, а не зашито: набор скриптов зависит от конфигурации
// проверяющего. Нужен скрипт из корня — у вложенного (`lib/foo.mjs`) сервер
// отдаёт пустой список файлов, это отдельная задача, а не предмет этой проверки.
// Мимо страницы — значит и мимо прокси Vite, который подставляет токен: без
// заголовка при включённом удалённом доступе вместо списка приедет отказ.
const scripts = await apiFetch('http://127.0.0.1:5178/api/scripts').then((r) => r.json());
if (!Array.isArray(scripts)) {
  console.log('скрипты — API не отдал список:', JSON.stringify(scripts).slice(0, 200));
  process.exit(1);
}
const flatScript = scripts.find((s) => !s.name.includes('/'));
if (!flatScript) {
  console.log('скрипты — в корне нет ни одного файла, проверять нечего');
  process.exit(1);
}
await page.goto('http://localhost:8888/scripts', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
await page.locator('button', { hasText: flatScript.name }).first().click();
await page.waitForTimeout(2500);
const scriptFile = await page.getByText(flatScript.name).count();
console.log('скрипт — файл в дереве:', scriptFile > 1 ? 'есть' : 'НЕТ');
await page.screenshot({ path: '.qa-screenshots/resources-script.png' });

await browser.close();
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
