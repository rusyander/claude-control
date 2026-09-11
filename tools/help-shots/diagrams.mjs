/**
 * Схемы справки: из `.drawio` в картинку, которая уезжает в приложение.
 *
 * Исходник схемы — генератор `docs/diagrams/<набор>/generate.mjs`, файл
 * `.drawio` — его вывод, а этот прогон делает третий шаг: разворачивает страницы
 * тем же движком, которым их рисует сам draw.io (его viewer), и снимает
 * результат.
 *
 * ПОЧЕМУ PNG, А НЕ SVG. Вектор был первым выбором и не подошёл: подписи в наших
 * карточках — HTML (`html=1`), и viewer выводит их через `<foreignObject>`, а
 * браузер не рисует его содержимое, когда SVG подключён картинкой через `<img>`.
 * Схема приехала бы в справку без единой буквы. Снимок с удвоенной плотностью
 * читается на любом экране и работает везде.
 *
 * Раскладка совпадает со снимками — каталог один на всю справку:
 *
 *   apps/web/public/help/<раздел>/diagrams/<имя>.png
 *   apps/web/public/help/<раздел>/diagrams/diagrams.json
 *
 * В описи рядом с картинками лежит отпечаток страницы `.drawio`, с которой
 * каждая снята: по нему `check-help-shots.mjs` краснеет, когда схему поправили
 * в генераторе, а экспорт забыли.
 *
 * Подпись схемы живёт в словаре под ключом `help.diagrams.<раздел>.<имя>`, и
 * `tools/qa/check-help-shots.mjs` сверяет три множества: файлы, ссылки из
 * документов и подписи.
 *
 * Нужна сеть: viewer подтягивается с viewer.diagrams.net — тем же способом, что
 * и в `shots.mjs` скилла drawio-architect. Без сети прогон честно падает, а не
 * пишет пустой файл.
 *
 * Запуск: node tools/help-shots/diagrams.mjs
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { SHOTS_ROOT, DIAGRAMS_MANIFEST, diagramPages, fingerprint } from './kit.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Что и куда. Порядок страниц — порядок в `.drawio`; имя файла задаётся здесь,
 * потому что имя страницы русское, а адрес в приложении должен быть латиницей.
 */
const SETS = [
  {
    source: 'docs/diagrams/platform-guide/platform-guide.drawio',
    topic: 'platform',
    pages: ['request-path', 'who-creates-what', 'two-systems'],
  },
  {
    source: 'docs/diagrams/tests-guide/tests-guide.drawio',
    topic: 'tests',
    pages: ['where-cases-live', 'what-turns-red'],
  },
  {
    source: 'docs/diagrams/chat-guide/chat-guide.drawio',
    topic: 'chat',
    pages: ['message-path', 'split-conveyor'],
  },
  {
    source: 'docs/diagrams/rules-guide/rules-guide.drawio',
    topic: 'rules',
    pages: ['rule-round-trip', 'rule-states'],
  },
  {
    source: 'docs/diagrams/claudeMd-guide/claudeMd-guide.drawio',
    topic: 'claudeMd',
    pages: ['instruction-layers', 'save-and-conflict'],
  },
  {
    source: 'docs/diagrams/projects-guide/projects-guide.drawio',
    topic: 'projects',
    pages: ['registry-and-files', 'other-cli'],
  },
  {
    source: 'docs/diagrams/groups-guide/groups-guide.drawio',
    topic: 'groups',
    pages: ['two-marks', 'compiled-set'],
  },
  {
    source: 'docs/diagrams/permissions-guide/permissions-guide.drawio',
    topic: 'permissions',
    pages: ['decision-order', 'where-rules-live'],
  },
  {
    source: 'docs/diagrams/mcp-guide/mcp-guide.drawio',
    topic: 'mcp',
    pages: ['probe-path', 'who-runs-what'],
  },
  {
    source: 'docs/diagrams/env-guide/env-guide.drawio',
    topic: 'env',
    pages: ['where-a-value-goes'],
  },
  {
    source: 'docs/diagrams/overview-guide/overview-guide.drawio',
    topic: 'overview',
    pages: ['where-numbers-come-from'],
  },
  {
    source: 'docs/diagrams/search-guide/search-guide.drawio',
    topic: 'search',
    pages: ['what-search-covers'],
  },
  {
    source: 'docs/diagrams/analytics-guide/analytics-guide.drawio',
    topic: 'analytics',
    pages: ['how-the-report-is-built'],
  },
  {
    source: 'docs/diagrams/history-guide/history-guide.drawio',
    topic: 'history',
    pages: ['where-the-feed-comes-from'],
  },
  {
    source: 'docs/diagrams/compare-guide/compare-guide.drawio',
    topic: 'compare',
    pages: ['what-crosses-and-what-does-not'],
  },
  {
    source: 'docs/diagrams/skills-guide/skills-guide.drawio',
    topic: 'skills',
    pages: ['skill-pickup', 'skill-on-disk'],
  },
  {
    source: 'docs/diagrams/commands-guide/commands-guide.drawio',
    topic: 'commands',
    pages: ['four-sources'],
  },
  {
    source: 'docs/diagrams/hooks-guide/hooks-guide.drawio',
    topic: 'hooks',
    pages: ['hook-flow', 'hook-storage'],
  },
  {
    source: 'docs/diagrams/scripts-guide/scripts-guide.drawio',
    topic: 'scripts',
    pages: ['script-usage'],
  },
  {
    source: 'docs/diagrams/plugins-guide/plugins-guide.drawio',
    topic: 'plugins',
    pages: ['plugin-install'],
  },
  {
    source: 'docs/diagrams/settings-guide/settings-guide.drawio',
    topic: 'settings',
    pages: ['what-happens-before-a-write'],
  },
  {
    source: 'docs/diagrams/providers-guide/providers-guide.drawio',
    topic: 'providers',
    pages: ['what-switching-changes'],
  },
  {
    source: 'docs/diagrams/endpoints-guide/endpoints-guide.drawio',
    topic: 'endpoints',
    pages: ['where-the-address-is-written'],
  },
  {
    source: 'docs/diagrams/integrations-guide/integrations-guide.drawio',
    topic: 'integrations',
    pages: ['who-calls-whom'],
  },
  {
    source: 'docs/diagrams/dlp-guide/dlp-guide.drawio',
    topic: 'dlp',
    pages: ['what-the-proxy-sees-and-what-the-gate-sees'],
  },
];

const browser = await chromium.launch();
try {
  for (const set of SETS) {
    const xml = readFileSync(join(ROOT, set.source), 'utf8');
    const dir = join(SHOTS_ROOT, set.topic, 'diagrams');
    mkdirSync(dir, { recursive: true });

    // Страница, выпавшая из набора, уносит свой файл: иначе в git остаётся
    // схема, на которую уже никто не ссылается, и однажды её снова покажут.
    const keep = new Set(set.pages.map((name) => `${name}.png`));
    keep.add(DIAGRAMS_MANIFEST);
    for (const name of readdirSync(dir)) {
      if (keep.has(name)) continue;
      rmSync(join(dir, name), { force: true });
      console.log(`  снята с учёта устаревшая схема ${name}`);
    }

    // Отпечаток страницы исходника — рядом с картинкой. Без него картинка
    // молча живёт своей жизнью: схему уже поправили в генераторе, а в справку
    // по-прежнему уезжает вчерашний экспорт, и никакая проверка этого не видит
    // (проверено на себе: адрес шлюза правился в генераторе, а в справке ещё
    // сутки стоял выдуманный порт).
    const sourcePages = diagramPages(xml);
    const manifest = { topic: set.topic, source: set.source, pages: [] };

    for (const [index, name] of set.pages.entries()) {
      const page = await browser.newPage({
        viewport: { width: 2400, height: 1600 },
        // Удвоенная плотность: схему увеличивают, чтобы прочитать мелкую строку
        // в карточке, и на однократной она рассыпается.
        deviceScaleFactor: 2,
      });
      try {
        const config = JSON.stringify({
          xml,
          page: index,
          toolbar: '',
          nav: false,
          resize: true,
          border: 16,
        });
        await page.setContent(
          '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
            `<div class="mxgraph" data-mxgraph="${config.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"></div>` +
            '<script src="https://viewer.diagrams.net/js/viewer.min.js"></script></body></html>',
          { waitUntil: 'networkidle' },
        );
        await page.waitForSelector('.mxgraph svg', { timeout: 30000 });
        await page.waitForTimeout(1500);

        // Белая подложка ставится здесь, а не в CSS справки: схема нарисована
        // тёмным по светлому, и прозрачный фон на тёмной теме съел бы её текст.
        const size = await page.evaluate(() => {
          const node = document.querySelector('.mxgraph svg');
          if (!node) return undefined;
          document.body.style.background = '#FFFFFF';
          const box = node.getBoundingClientRect();
          return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
        });
        if (!size || size.width < 200) {
          throw new Error(`страница ${index + 1} (${name}) не отрисовалась — сеть или viewer`);
        }

        const file = join(dir, `${name}.png`);
        await page.locator('.mxgraph svg').screenshot({ path: file, scale: 'device' });
        manifest.pages.push({
          name,
          file: `${name}.png`,
          page: index + 1,
          source: fingerprint(sourcePages[index] ?? ''),
          width: size.width,
          height: size.height,
          exportedAt: new Date().toISOString(),
        });
        console.log(
          `  схема ${set.topic}/${name}: ${size.width}×${size.height}, ` +
            `${Math.round(statSync(file).size / 1024)} КБ`,
        );
      } finally {
        await page.close();
      }
    }

    writeFileSync(join(dir, DIAGRAMS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
} finally {
  await browser.close();
}
