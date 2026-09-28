/**
 * Даты и время — по языку ИНТЕРФЕЙСА, а не браузера (F-323 и его соседи).
 *
 * Браузер открыт в локали en-US, а интерфейс переключается ru ↔ en. Прежде
 * журнал защиты данных и «проверено …» у интеграции брали локаль браузера:
 * русский интерфейс показывал «9/8/2026, 10:00:00 AM». Проверяется оба места в
 * обоих языках: в русском нет AM/PM и американского порядка даты, в английском
 * они есть.
 *
 * Ответы подменены там, где проверка зависит от данных (журнал, статус
 * интеграций); ни одна запись на сервер не уходит, настройки стенда не меняются.
 *
 * Запуск: `node tools/qa/check-dates-ui-language.mjs` при поднятом `pnpm dev`.
 * Снимки: `SHOTS=<каталог> node tools/qa/check-dates-ui-language.mjs`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const AT = '2026-09-08T15:04:05.000Z';

const JOURNAL = {
  entries: [
    {
      at: AT,
      path: '/v1/messages',
      apiKind: 'anthropic',
      decision: 'masked',
      bytes: 1024,
      hits: [],
    },
  ],
};

/** Американская запись: «9/8/2026» и «AM/PM». */
const US = /\d{1,2}\/\d{1,2}\/\d{4}|\b[AP]M\b/;

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const shotsDir = process.env.SHOTS;
const browser = await chromium.launch();

for (const lang of ['ru', 'en']) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  await bypassOnboarding(page, { language: lang });
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  const shot = async (name) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}-${lang}.png`), fullPage: true });
  };

  // Журнал включён в подмене: без этого карточка не спрашивает записи вовсе.
  await page.route('**/api/dlp', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, journal: true } });
  });
  await page.route('**/api/dlp/journal', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 501, json: {} });
    return route.fulfill({ json: JOURNAL });
  });
  await page.route('**/api/integrations', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    const statuses = Array.isArray(body) ? body : [];
    return route.fulfill({
      response,
      json: statuses.map((status) => ({ ...status, checkedAt: AT })),
    });
  });

  // 1. Журнал защиты данных.
  await page.goto(`${BASE}/dlp?tab=journal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  // Английский словарь грузится отдельным чанком: ждём, пока меню заговорит на
  // языке проверки, иначе строка снята ещё в русском первом кадре.
  await page
    .getByRole('navigation')
    .getByText(lang === 'ru' ? 'Обзор' : 'Overview', { exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await page.getByText('/v1/messages').first().waitFor({ timeout: 30_000 });
  const row = page.getByText('/v1/messages').first().locator('xpath=..');
  const rowText = await row.innerText();
  if (lang === 'ru')
    check(
      !US.test(rowText),
      `ru: журнал DLP без AM/PM и m/d/y — «${rowText.split('\n')[1] ?? rowText}»`,
    );
  else
    check(
      US.test(rowText),
      `en: журнал DLP в английской записи — «${rowText.split('\n')[1] ?? rowText}»`,
    );
  await shot('dlp-journal');

  // 2. Интеграции: «проверено …».
  await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  // «проверено <время>» — не «not checked» соседней карточки.
  const checked = page.getByText(lang === 'ru' ? /^проверено \d/i : /^checked \d/i).first();
  await checked.waitFor({ timeout: 30_000 });
  const checkedText = await checked.innerText();
  if (lang === 'ru') check(!US.test(checkedText), `ru: интеграция — «${checkedText}»`);
  else check(US.test(checkedText), `en: интеграция — «${checkedText}»`);
  await shot('integrations');

  check(
    problems.length === 0,
    `${lang}: ошибок страницы нет${problems.length ? `: ${problems[0]}` : ''}`,
  );
  await context.close();
}

console.log(bad === 0 ? '\nДаты по языку интерфейса: всё на месте.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
