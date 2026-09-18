/**
 * Проверка песочницы во всех разделах: открывается ли окно, собирается ли
 * состав, работает ли прямой прогон хука. Разговор с моделью здесь не
 * запускается — он проверяется отдельно, чтобы прогон оставался быстрым.
 *
 * Прогон обязан уметь краснеть. Раньше он этого не умел дважды: мастер
 * онбординга на свежем стенде закрывал собой все страницы, кнопок песочницы
 * никто не находил, и шесть строк «кнопки песочницы нет» выходили нулём — как
 * полный успех. Поэтому здесь: обход мастера, число элементов раздела берётся
 * у сервера (пустой раздел — это «проверять нечего», а не «кнопки нет»),
 * элемент без кнопки песочницы — отказ, и отказ виден кодом возврата.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'sandbox');
mkdirSync(OUT_DIR, { recursive: true });

/** Раздел, его адрес и список сервера, по которому видно, есть ли что проверять. */
const SECTIONS = [
  ['rules', '/rules', '/api/rules'],
  ['skills', '/skills', '/api/skills'],
  ['hooks', '/hooks', '/api/hooks'],
  ['scripts', '/scripts', '/api/scripts'],
  ['mcp', '/mcp', '/api/mcp'],
  ['groups', '/groups', '/api/groups'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const problems = [];
let checked = 0;

for (const [name, path, api] of SECTIONS) {
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${name}] console: ${message.text()}`);
  });

  try {
    await bypassOnboarding(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await page.waitForTimeout(1200);

    // Список спрашиваем со страницы, а не из node: у панели с удалённым доступом
    // API требует токен, а браузеру хватает разрешённого источника.
    const items = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) return { error: `${url}: HTTP ${response.status}` };
      const body = await response.json();
      return { count: Array.isArray(body) ? body.length : 0 };
    }, api);
    if (items.error) throw new Error(items.error);

    const button = page.getByRole('button', { name: /Песочница:/ }).first();
    if ((await button.count()) === 0) {
      if (items.count === 0) {
        console.log(`${name.padEnd(8)} — в разделе ничего нет, проверять нечего`);
      } else {
        problems.push(`[${name}] элементов ${items.count}, а кнопки песочницы ни одной`);
        console.log(`${name.padEnd(8)} ОТКАЗ — элементов ${items.count}, кнопки песочницы нет`);
      }
      await page.close();
      continue;
    }

    await button.click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);

    // Состав песочницы приходит с сервера — он и подтверждает, что она собралась.
    const contents = await page.locator('[role="dialog"]').innerText();
    await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
    checked += 1;

    // У хуков и скриптов есть мгновенный прогон — проверяем именно его.
    const runButton = page.getByRole('button', { name: /Прогнать все/ });
    if (await runButton.count()) {
      await runButton.click();
      await page.waitForTimeout(6000);
      await page.screenshot({ path: join(OUT_DIR, `${name}-probe.png`) });

      const decisions = await page.locator('[role="dialog"]').innerText();
      const stopped = (decisions.match(/остановил|запросил подтверждение/g) ?? []).length;
      const failed = (decisions.match(/не отработал/g) ?? []).length;
      console.log(
        `${name.padEnd(8)} OK — прогон выполнен, вмешательств: ${stopped}, не отработал: ${failed}`,
      );
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

// Прогон, не открывший НИ ОДНОЙ песочницы, ничего не доказал: пустая
// конфигурация — это повод сказать об этом вслух, а не повод показать «чисто».
if (checked === 0) problems.push('ни одной песочницы не открыто — проверять было нечего');

console.log(problems.length ? `\nПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : '\nОшибок консоли нет.');
process.exitCode = problems.length ? 1 : 0;
