/**
 * Обход всех разделов приложения: снимает скриншоты и собирает ошибки консоли.
 * Нужен, чтобы проверять интерфейс глазами и ловить рантайм-ошибки, которых
 * не видит tsc: сломанную вёрстку, упавший рендер, пустые списки.
 *
 * Запуск: node tools/qa/screenshot.mjs [light|dark]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const THEME = process.argv[2] ?? 'light';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', THEME);

const ROUTES = [
  ['overview', '/'],
  ['analytics', '/analytics'],
  ['rules', '/rules'],
  ['skills', '/skills'],
  ['hooks', '/hooks'],
  ['scripts', '/scripts'],
  ['plugins', '/plugins'],
  ['mcp', '/mcp'],
  ['permissions', '/permissions'],
  ['env', '/env'],
  ['groups', '/groups'],
  ['settings', '/settings'],
  ['help', '/help'],
];

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: THEME === 'dark' ? 'dark' : 'light',
});

const problems = [];

for (const [name, path] of ROUTES) {
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${name}] console: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`[${name}] pageerror: ${error.message}`);
  });

  // Ждать networkidle нельзя: приложение держит открытым SSE-соединение
  // для отслеживания изменений файлов, и сеть никогда не затихает.
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 15_000 });
  // Данные приходят асинхронно — даём кадру дорисоваться, иначе на скриншоте
  // окажется состояние загрузки, а не итоговый экран.
  await page.waitForTimeout(900);

  await page.screenshot({ path: join(OUT_DIR, `${name}.png`), fullPage: true });

  // Пустой экран — верный признак, что рендер упал молча.
  const textLength = (await page.locator('body').innerText()).trim().length;
  if (textLength < 40) problems.push(`[${name}] страница почти пустая (${textLength} символов)`);

  await page.close();
}

await browser.close();

console.log(`Скриншоты (${THEME}): ${OUT_DIR}`);
if (problems.length === 0) {
  console.log('Ошибок консоли и пустых страниц не найдено.');
} else {
  console.log(`\nНАЙДЕНО ПРОБЛЕМ: ${problems.length}`);
  for (const problem of problems) console.log('  - ' + problem);
}
