/**
 * Кнопка «?» раздела ведёт на справку ИМЕННО этого раздела.
 *
 * `check-help.mjs` требует, чтобы кнопка была; здесь — чтобы она была верной.
 * Скопированный `PageHeader` с чужим `helpTopic` проходит первую проверку и
 * отправляет человека читать не о том разделе, где он стоит.
 *
 * Для каждого раздела из реестра `pages/Help/model/topics.ts` (пара
 * `id` + `pagePath`): открыть раздел, найти ссылку `/help?topic=…` (в шапке или
 * в собственном меню раздела), убедиться, что её тема — одна из тем ЭТОГО пути,
 * нажать и увидеть адрес справки с той же темой. Ничего не пишет.
 *
 * Запуск: `node tools/qa/check-help-topic.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const registry = await readFile('apps/web/src/pages/Help/model/topics.ts', 'utf8');
// `[^{}]` не даёт шаблону перешагнуть в соседнюю запись.
const byPath = new Map();
for (const match of registry.matchAll(/\{\s*id:\s*'([^']+)'[^{}]*?pagePath:\s*'([^']+)'/g)) {
  const set = byPath.get(match[2]) ?? new Set();
  set.add(match[1]);
  byPath.set(match[2], set);
}
if (byPath.size === 0) {
  console.log('Не удалось прочитать пары тема → раздел из pages/Help/model/topics.ts');
  process.exit(1);
}

const browser = await chromium.launch();
let bad = 0;
let checked = 0;

for (const [path, topics] of byPath) {
  const page = await browser.newPage();
  await bypassOnboarding(page);
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  const link = page
    .locator('main a[href*="/help?topic="], [role="dialog"] a[href*="/help?topic="]')
    .first();
  let found = await link
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  // Ссылка может жить в меню раздела (чат: «Настройки чата») — как в check-help.
  // Только меню самой страницы (`main`): кнопка агента панели в боковой полосе
  // тоже `aria-haspopup`, и клик по ней под оверлеем закрытого меню висел 30 с,
  // роняя весь прогон. Клик с потолком, после Escape — ждём, пока оверлей уйдёт.
  if (!found) {
    const menus = page.locator('main button[aria-haspopup="dialog"]');
    for (let i = 0; i < (await menus.count()) && !found; i++) {
      const opened = await menus
        .nth(i)
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) continue;
      found = await link
        .waitFor({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      if (!found) {
        await page.keyboard.press('Escape');
        await page
          .locator('[data-state="open"][aria-hidden="true"]')
          .first()
          .waitFor({ state: 'detached', timeout: 2000 })
          .catch(() => undefined);
      }
    }
  }
  if (!found) {
    // Отсутствие кнопки — дело check-help; здесь проверять нечего, но и молчать нельзя.
    bad++;
    console.log(`✗ ${path}: ссылки на справку нет`);
    await page.close();
    continue;
  }
  const href = (await link.getAttribute('href')) ?? '';
  const topic = new URL(href, BASE).searchParams.get('topic') ?? '';
  checked++;
  if (!topics.has(topic)) {
    bad++;
    console.log(`✗ ${path}: «?» ведёт на тему «${topic}», а у раздела ${[...topics].join(' | ')}`);
    await page.close();
    continue;
  }
  await link.click();
  const landed = await page
    .waitForURL((url) => url.pathname === '/help' && url.searchParams.get('topic') === topic, {
      timeout: 5000,
    })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    bad++;
    console.log(`✗ ${path}: нажатие «?» не открыло /help?topic=${topic} (адрес ${page.url()})`);
  } else {
    console.log(`✓ ${path} → ${topic}`);
  }
  await page.close();
}

await browser.close();
console.log(
  bad
    ? `\nРазделов с неверной или неработающей «?»: ${bad} из ${byPath.size}`
    : `\n«?» ведёт на свою тему во всех разделах (${checked})`,
);
process.exitCode = bad ? 1 : 0;
