/**
 * Прогон справки, две проверки.
 *
 * 1. Каждый документ открывается на живом стенде, и в тексте ищутся утёкшие
 *    ключи i18n — ключ, вызванный под именем, которого нет в словаре, виден на
 *    странице как `help.…`. `tsc` проверяет полноту словаря, но не места
 *    вызова, поэтому такая опечатка ловится только глазами или отсюда.
 * 2. На каждом разделе, у которого есть документ, должна быть кнопка «?».
 *    Она ставится РУКАМИ (`helpTopic` у `PageHeader`), автоматической быть не
 *    может — шапка живёт в `shared/ui` и о справке не знает. Забыть её легко:
 *    у истории, поиска и проектов документы были, а кнопки не было, и заметить
 *    это можно было только открыв страницу. Теперь замечает прогон.
 *
 * Список тем берётся из самого реестра `pages/Help/model/topics.ts`: новый
 * документ попадает в обе проверки сам, без правки этого файла.
 *
 * Язык только ru: `en.ts` типизирован по `ru.ts`, недостающий ключ там ловит
 * type-check.
 *
 * Запуск: `node tools/qa/check-help.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const registry = await readFile('apps/web/src/pages/Help/model/topics.ts', 'utf8');
const TOPICS = [...new Set([...registry.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]))];
if (TOPICS.length === 0) {
  console.log('Не удалось прочитать список тем из pages/Help/model/topics.ts');
  process.exit(1);
}

// Разделы, у которых есть документ. Один путь может нести два документа
// (настройки и провайдеры), кнопка при этом одна — поэтому набор, а не список.
const PAGES = [...new Set([...registry.matchAll(/\bpagePath:\s*'([^']+)'/g)].map((m) => m[1]))];

const browser = await chromium.launch();
let bad = 0;

// Своя вкладка на документ: одна вкладка на весь обход выдыхается примерно
// после восьмого перехода — `nav` перестаёт появляться, и прогон падает по
// таймауту на случайной теме. То же лечение стоит в `tools/qa/audit-layout.mjs`.
for (const topic of TOPICS) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/help?topic=${topic}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(600);
  const text = await page.evaluate(() => document.body.innerText);
  const leaks = [
    ...new Set(text.match(/\b(help|providerPermissions|common)\.[A-Za-z0-9_.]+/g) ?? []),
  ];
  if (leaks.length) {
    bad++;
    console.log(`${topic}: ${leaks.join(', ')}`);
  }
  await page.close();
}

// Вторая проверка: кнопка «?» на самом разделе. Ссылка одна и та же везде —
// `/help?topic=…`; в боковом меню «Справка» ведёт на `/help` без темы, поэтому
// с ней не путается.
let noButton = 0;
for (const path of PAGES) {
  const page = await browser.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(400);
  const found = await page.locator('a[href*="/help?topic="]').count();
  if (found === 0) {
    noButton++;
    console.log(`${path}: нет кнопки «?», хотя документ справки для раздела есть`);
  }
  await page.close();
}

await browser.close();
console.log(
  bad ? `Утечки ключей на ${bad} документах` : `Справка чиста (${TOPICS.length} документов)`,
);
console.log(
  noButton
    ? `Разделов без кнопки «?»: ${noButton} из ${PAGES.length}`
    : `Кнопка «?» на месте во всех разделах (${PAGES.length})`,
);
process.exit(bad || noButton ? 1 : 0);
