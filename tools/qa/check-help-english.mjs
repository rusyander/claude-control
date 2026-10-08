/**
 * Кейс help-005: справка на английском не показывает сырых ключей и русского
 * текста — каждый документ целиком на английском, строк вида `help.xxx` нет.
 *
 * Кейс просит пять любых тем — здесь берутся ВСЕ темы реестра
 * `pages/Help/model/topics.constants.ts`: новая тема попадает в проверку сама. Язык —
 * настоящая настройка панели (`language: 'en'` в state.json стенда до старта).
 * Русский ищется по кириллице в видимом тексте документа: `tsc` сверяет
 * полноту `en` с `ru` по ключам, но не видит русскую строку, вписанную прямо в
 * компонент, и ключ, вызванный под несуществующим именем.
 *
 * Запуск: `node tools/qa/check-help-english.mjs` (стенд поднимается сам).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';

const registry = readFileSync(
  join(REPO, 'apps/web/src/pages/Help/model/topics.constants.ts'),
  'utf8',
);
const TOPICS = [...new Set([...registry.matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1]))];
const CYRILLIC = /[А-Яа-яЁё]+(?:[\s,.:;«»-]+[А-Яа-яЁё]+)*/g;
/**
 * Слова синтаксиса, который панель разбирает буквально: заголовок правила в
 * CLAUDE.md — «## ПРАВИЛО: …» на любом языке интерфейса. Перевести его значило
 * бы научить человека писать заголовок, который панель не узнает.
 */
const SYNTAX = /ПРАВИЛО/g;
/**
 * Русское в кавычках “…” или "…" — цитата данных, а не непереведённый текст:
 * строка файла на английском кадре, пример склонений фамилии в «Защите данных».
 * Ёлочки не прощаются: английский текст ими не цитирует данные, а называет
 * кнопки и вопросы — русское там и есть непереведённое.
 */
const unquotedRussian = (text) =>
  text
    .replace(/“[^”\n]*”|"[^"\n]*"/g, ' ')
    .replace(SYNTAX, ' ')
    .match(CYRILLIC) ?? [];

await runOnStand({ label: 'help-english', settings: { language: 'en' } }, async (stand, check) => {
  check('темы прочитаны из реестра', TOPICS.length >= 5, `${TOPICS.length}`);
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 900 });
    for (const topic of TOPICS) {
      await page.goto(`${stand.webUrl}/help?topic=${topic}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
      await wait(400);
      const text = await page.locator('main').innerText();
      const raw = [...new Set(text.match(/\bhelp\.[a-zA-Z_][\w.]*/g) ?? [])];
      const russian = [...new Set(unquotedRussian(text))];
      check(`${topic}: нет сырых ключей help.…`, raw.length === 0, raw.join(', '));
      // В подробностях — окружение каждого слова: по одному слову не решить,
      // непереведённый это текст или данные (синтаксис, строка файла).
      const around = (word) => {
        const at = text.indexOf(word);
        return text.slice(Math.max(0, at - 50), at + word.length + 30).replace(/\s+/g, ' ');
      };
      check(
        `${topic}: нет русского текста`,
        russian.length === 0,
        russian.slice(0, 8).map(around).join('\n    '),
      );
    }
    const nav = await page.locator('nav').first().innerText();
    check('боковая панель тоже на английском', !CYRILLIC.test(nav), nav.slice(0, 200));
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
