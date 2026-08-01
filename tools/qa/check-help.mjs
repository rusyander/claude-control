/**
 * Прогон справки: каждый её документ открывается на живом стенде, и в тексте
 * ищутся утёкшие ключи i18n — ключ, вызванный под именем, которого нет в
 * словаре, виден на странице как `help.…`. `tsc` проверяет полноту словаря, но
 * не места вызова, поэтому такая опечатка ловится только глазами или отсюда.
 *
 * Список тем берётся из самого реестра `pages/Help/model/topics.ts`: новый
 * документ попадает в прогон сам, без правки этого файла.
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

await browser.close();
console.log(
  bad ? `Утечки ключей на ${bad} документах` : `Справка чиста (${TOPICS.length} документов)`,
);
process.exit(bad ? 1 : 0);
