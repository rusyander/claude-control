/**
 * Кадры справки под тему и язык панели: светлая/тёмная × ru/en.
 *
 * Что доказывается на настоящем пути, а не в модели:
 *
 *  1. Для каждой из четырёх пар «тема × язык», записанной НАСТОЯЩЕЙ настройкой
 *     панели (PATCH /api/settings, как её пишет раздел «Настройки»), каждый
 *     `<HelpShot>` каждого раздела показывает ровно тот файл, который велит
 *     порядок замены: точный вариант → та же тема на другом языке → светлый
 *     того же языка → светлый русский. Ожидание считается здесь заново по
 *     описи вариантов на диске (`<раздел>/variants.json`), независимо от
 *     `model/shotVariant.ts`.
 *  2. У картинки стоят `width`/`height` из описи — место под неё
 *     зарезервировано до загрузки.
 *  3. В разделе-образце (`--topic`, по умолчанию `overview`) каждая картинка
 *     действительно загружается, её настоящий размер совпадает с объявленным,
 *     и ни один запрос картинки не отвечает 4xx/5xx.
 *  4. Смена темы без перезагрузки меняет файл, но не двигает страницу:
 *     накопленный сдвиг раскладки (Layout Instability API) после смены — 0.
 *     Тема здесь переключается тем же атрибутом `data-theme`, который ставит
 *     ThemeProvider из настроек, — проверяется реакция справки на смену темы,
 *     а запись настройки уже доказана пунктом 1.
 *
 * Сторож обязан уметь краснеть: пункт 1 требует, чтобы хотя бы один кадр в
 * каждой паре показал ТОЧНЫЙ вариант, иначе опись без тёмных кадров прошла бы
 * «зелёной» одними заменами.
 *
 * Запуск: `node tools/qa/check-help-shot-variants.mjs [--topic overview]`
 * (стенд поднимается сам, рабочий стенд человека не трогается).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';

const HELP_ROOT = join(REPO, 'apps/web/public/help');
const TOPICS_REGISTRY = join(REPO, 'apps/web/src/pages/Help/model/topics.ts');
const sampleArg = process.argv.indexOf('--topic');
const SAMPLE = sampleArg > 0 ? process.argv[sampleArg + 1] : 'overview';

const PAIRS = [
  ['light', 'ru'],
  ['light', 'en'],
  ['dark', 'ru'],
  ['dark', 'en'],
];

/** Порядок замены — спецификация из задачи, записанная здесь независимо от модели. */
function chain(theme, lang) {
  const other = lang === 'en' ? 'ru' : 'en';
  return [...new Set([`${theme}-${lang}`, `${theme}-${other}`, `light-${lang}`, 'light-ru'])];
}

function readIndex(topic) {
  const path = join(HELP_ROOT, topic, 'variants.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function expectedFor(topic, key, theme, lang) {
  const variants = readIndex(topic)?.frames?.[key];
  const [scenario, frame] = key.split('/');
  if (!variants) return { src: `/help/${topic}/${scenario}/${frame}.png`, variant: 'light-ru' };
  for (const variant of chain(theme, lang)) {
    const found = variants[variant];
    if (found) {
      return {
        src: `/help/${topic}/${scenario}/${found.file}`,
        variant,
        width: String(found.width),
        height: String(found.height),
      };
    }
  }
  return { src: `/help/${topic}/${scenario}/${frame}.png`, variant: 'light-ru' };
}

const topics = [
  ...new Set(
    [...readFileSync(TOPICS_REGISTRY, 'utf8').matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]),
  ),
].filter((topic) => readIndex(topic));

/** Все `<HelpShot>` страницы: адрес, объявленный размер, вариант, кадр. */
async function shotsOnPage(page) {
  return page.locator('main img[data-shot]').evaluateAll((nodes) =>
    nodes.map((img) => ({
      shot: img.getAttribute('data-shot'),
      src: img.getAttribute('src'),
      variant: img.getAttribute('data-variant'),
      width: img.getAttribute('width'),
      height: img.getAttribute('height'),
    })),
  );
}

async function openTopic(page, web, topic) {
  await page.goto(`${web}/help?topic=${topic}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
  // Опись вариантов приходит отдельным запросом; до неё картинок нет вовсе.
  await page
    .waitForFunction(
      () => document.querySelectorAll('main figure img[data-shot]').length > 0,
      null,
      {
        timeout: 10_000,
      },
    )
    .catch(() => undefined);
  await wait(300);
}

await runOnStand({ label: 'help-shot-variants' }, async (stand, check) => {
  check(`в каталоге есть разделы с описью вариантов`, topics.length > 0, String(topics.length));
  check(`раздел-образец ${SAMPLE} с описью вариантов`, topics.includes(SAMPLE));
  const browser = await chromium.launch();
  try {
    for (const [theme, lang] of PAIRS) {
      const label = `${theme}-${lang}`;
      const saved = await stand.api('/settings', {
        method: 'PATCH',
        body: { theme, language: lang },
      });
      check(`${label}: настройка записана`, saved.status < 300, saved.text.slice(0, 200));
      const page = await stand.newPage(browser, { height: 900 });
      const bad = [];
      page.on('response', (res) => {
        if (res.request().resourceType() === 'image' && res.status() >= 400) {
          bad.push(`${res.status()} ${res.url()}`);
        }
      });

      let total = 0;
      let exact = 0;
      const wrong = [];
      for (const topic of topics) {
        await openTopic(page, stand.webUrl, topic);
        const applied = await page.evaluate(() => [
          document.documentElement.dataset.theme,
          document.documentElement.lang,
        ]);
        if (applied[0] !== theme || !applied[1].startsWith(lang)) {
          wrong.push(`${topic}: страница в ${applied.join('/')}, ждали ${theme}/${lang}`);
          continue;
        }
        for (const shot of await shotsOnPage(page)) {
          total += 1;
          const want = expectedFor(topic, shot.shot, theme, lang);
          if (want.variant === label) exact += 1;
          const got = `${shot.src} [${shot.variant}] ${shot.width}×${shot.height}`;
          const expected = `${want.src} [${want.variant}] ${want.width ?? null}×${want.height ?? null}`;
          if (
            shot.src !== want.src ||
            shot.variant !== want.variant ||
            shot.width !== (want.width ?? null) ||
            shot.height !== (want.height ?? null)
          ) {
            wrong.push(`${topic}/${shot.shot}: показан ${got}, ждали ${expected}`);
          }
        }
      }
      console.log(`  ${label}: кадров на страницах ${total}, точного варианта ${exact}`);
      check(`${label}: кадры на страницах есть`, total > 0, String(total));
      check(
        `${label}: каждый кадр — по порядку замены, с размером из описи`,
        wrong.length === 0,
        wrong.slice(0, 15).join('\n    '),
      );
      check(`${label}: хотя бы один кадр — точный вариант пары`, exact > 0, String(exact));

      // Раздел-образец: картинки грузятся по-настоящему, размер совпадает.
      await openTopic(page, stand.webUrl, SAMPLE);
      const images = page.locator('main img[data-shot]');
      const count = await images.count();
      for (let i = 0; i < count; i += 1) {
        await images
          .nth(i)
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await images
          .nth(i)
          .evaluate((img) =>
            img.complete && img.naturalWidth > 0
              ? undefined
              : new Promise((done) => {
                  img.addEventListener('load', done, { once: true });
                  img.addEventListener('error', done, { once: true });
                  setTimeout(done, 8000);
                }),
          )
          .catch(() => undefined);
      }
      const drawn = await images.evaluateAll((nodes) =>
        nodes
          .filter(
            (img) =>
              !(img.complete && img.naturalWidth > 0) ||
              (img.getAttribute('width') &&
                (String(img.naturalWidth) !== img.getAttribute('width') ||
                  String(img.naturalHeight) !== img.getAttribute('height'))),
          )
          .map(
            (img) =>
              `${img.getAttribute('src')}: нарисовано ${img.naturalWidth}×${img.naturalHeight}, ` +
              `объявлено ${img.getAttribute('width')}×${img.getAttribute('height')}`,
          ),
      );
      check(
        `${label}: в ${SAMPLE} все ${count} картинок нарисованы в объявленном размере`,
        count > 0 && drawn.length === 0,
        drawn.join('\n    '),
      );
      check(`${label}: ни одного 4xx/5xx на картинку`, bad.length === 0, bad.join('\n    '));

      // Смена темы без перезагрузки: файл меняется, страница не сдвигается.
      if (theme === 'light') {
        await page.evaluate(() => window.scrollTo(0, 0));
        const before = await shotsOnPage(page);
        const shift = await page.evaluate(async () => {
          let sum = 0;
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) sum += entry.value;
            }
          });
          observer.observe({ type: 'layout-shift', buffered: false });
          document.documentElement.dataset.theme = 'dark';
          await new Promise((done) => setTimeout(done, 2500));
          observer.disconnect();
          return sum;
        });
        const after = await shotsOnPage(page);
        const switched = after.filter((shot, i) => shot.src !== before[i]?.src).length;
        const wantDark = after.filter(
          (shot) => expectedFor(SAMPLE, shot.shot, 'dark', lang).src === shot.src,
        ).length;
        check(
          `${label} → dark без перезагрузки: кадры сменили файл на тёмный`,
          switched > 0 && wantDark === after.length,
          `сменили ${switched}, по порядку замены ${wantDark} из ${after.length}`,
        );
        check(
          `${label} → dark без перезагрузки: сдвиг раскладки 0`,
          shift === 0,
          `накопленный сдвиг ${shift}`,
        );
      }
      check(
        `${label}: без необработанных ошибок`,
        page.errors.length === 0,
        page.errors.join(' | '),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
