/**
 * Прогон раздела «Команды»: список, поиск, фильтр по источнику, переход к
 * правке, оба языка и документ справки. Снимки — в `.qa-screenshots/commands`.
 *
 * Запуск: `node tools/qa/check-commands.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'commands');
await mkdir(OUT_DIR, { recursive: true });

const problems = [];
const browser = await chromium.launch();

/** Своя вкладка на случай: после десятка переходов приложение перестаёт рисовать `nav`. */
async function open(path, language) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  // Тот же приём, что в bypass-onboarding.mjs, плюс язык: один обработчик на
  // оба подмена, иначе они гоняются и ответ приходит в уже закрытую вкладку.
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json();
      body.onboardingDone = true;
      body.language = language;
      await route.fulfill({ response, json: body });
    } catch {
      /* вкладка уже закрыта — ответ никому не нужен */
    }
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  return { page, errors: consoleErrors };
}

const rowsOf = (page) => page.locator('[data-command]');

async function finish(page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.close();
}

// 1. Русский список: строки, поиск, фильтр, переход к правке.
{
  const { page, errors } = await open('/commands', 'ru');
  const total = await rowsOf(page).count();
  if (total < 100) problems.push(`ru: в списке всего ${total} команд — ожидалось >100`);
  await page.screenshot({ path: join(OUT_DIR, 'list-ru.png') });

  const search = page.getByRole('searchbox').first();
  await search.fill('/git');
  await page.waitForTimeout(400);
  const found = await rowsOf(page).count();
  if (found === 0 || found >= total) problems.push(`ru: поиск «/git» дал ${found} из ${total}`);
  await page.screenshot({ path: join(OUT_DIR, 'search-ru.png') });

  await search.fill('');
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: /^Скиллы · \d+$/ }).click();
  await page.waitForTimeout(400);
  const skills = await rowsOf(page).count();
  if (skills === 0 || skills >= total) problems.push(`ru: фильтр «Скиллы» дал ${skills}`);
  await page.screenshot({ path: join(OUT_DIR, 'filter-skills-ru.png') });

  await page.getByRole('button', { name: 'Открыть' }).first().click();
  await page.waitForTimeout(1200);
  const url = page.url();
  if (!/\/skills\?id=/.test(url)) problems.push(`ru: переход к правке привёл на ${url}`);
  await page.screenshot({ path: join(OUT_DIR, 'jump-to-skill.png') });

  if (errors.length) problems.push(`ru: ошибки в консоли — ${errors.slice(0, 3).join(' | ')}`);
  await finish(page);
}

// 2. Английский список: интерфейс переведён, описания из файлов — как есть.
{
  const { page, errors } = await open('/commands', 'en');
  const total = await rowsOf(page).count();
  if (total < 100) problems.push(`en: в списке всего ${total} команд`);
  const body = await page.locator('main').innerText();
  if (/commands\.[a-zA-Z]/.test(body)) problems.push('en: на странице виден ключ commands.*');
  const header = body.split('\n').slice(0, 12).join('\n');
  if (/[А-Яа-я]{4,}/.test(header)) problems.push('en: русский текст в шапке при английском языке');
  await page.screenshot({ path: join(OUT_DIR, 'list-en.png') });
  if (errors.length) problems.push(`en: ошибки в консоли — ${errors.slice(0, 3).join(' | ')}`);
  await finish(page);
}

// 3. Документ справки на обоих языках: сырых ключей быть не должно.
for (const language of ['ru', 'en']) {
  const { page, errors } = await open('/help?topic=commands', language);
  const body = await page.locator('main').innerText();
  const leaks = body.match(/help\.[a-zA-Z.]+/g);
  if (leaks)
    problems.push(`${language}: в справке видны сырые ключи — ${leaks.slice(0, 5).join(', ')}`);
  if (body.length < 800) problems.push(`${language}: документ справки подозрительно короткий`);
  await page.screenshot({ path: join(OUT_DIR, `help-${language}.png`), fullPage: true });
  if (errors.length) problems.push(`${language} (справка): ${errors.slice(0, 3).join(' | ')}`);
  await finish(page);
}

await browser.close();

if (problems.length) {
  console.log('ПРОБЛЕМЫ:');
  for (const problem of problems) console.log(' -', problem);
  process.exit(1);
}
console.log(
  'Команды: список, поиск, фильтр, переход к правке, оба языка и справка — без замечаний.',
);
