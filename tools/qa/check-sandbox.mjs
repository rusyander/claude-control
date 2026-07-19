/**
 * Проверка песочницы во всех разделах: открывается ли окно, собирается ли
 * состав, работает ли прямой прогон хука. Разговор с моделью здесь не
 * запускается — он проверяется отдельно, чтобы прогон оставался быстрым.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'sandbox');
mkdirSync(OUT_DIR, { recursive: true });

const SECTIONS = [
  ['rules', '/rules'],
  ['skills', '/skills'],
  ['hooks', '/hooks'],
  ['scripts', '/scripts'],
  ['mcp', '/mcp'],
  ['groups', '/groups'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const problems = [];

for (const [name, path] of SECTIONS) {
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${name}] console: ${message.text()}`);
  });

  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await page.waitForTimeout(1200);

    const button = page.getByRole('button', { name: /Песочница:/ }).first();
    if ((await button.count()) === 0) {
      console.log(`${name.padEnd(8)} — кнопки песочницы нет`);
      await page.close();
      continue;
    }

    await button.click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);

    // Состав песочницы приходит с сервера — он и подтверждает, что она собралась.
    const contents = await page.locator('[role="dialog"]').innerText();
    await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });

    // У хуков и скриптов есть мгновенный прогон — проверяем именно его.
    const runButton = page.getByRole('button', { name: /Прогнать все/ });
    if (await runButton.count()) {
      await runButton.click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: join(OUT_DIR, `${name}-probe.png`) });

      const decisions = await page.locator('[role="dialog"]').innerText();
      const stopped = (decisions.match(/остановил|запросил подтверждение/g) ?? []).length;
      console.log(`${name.padEnd(8)} OK — прогон выполнен, вмешательств: ${stopped}`);
    } else {
      console.log(`${name.padEnd(8)} OK — окно открылось (${contents.length} символов)`);
    }
  } catch (error) {
    problems.push(`[${name}] ${error.message.split('\n')[0]}`);
    console.log(`${name.padEnd(8)} ОШИБКА`);
  }

  await page.close();
}

await browser.close();
console.log(problems.length ? `\nПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : '\nОшибок консоли нет.');
