/**
 * Аудит вёрстки по всем разделам панели (`panel-pages.mjs` — один список на все
 * обходы): то, что видно глазом, но не ловится типами. Замеры и их коды — в
 * `layout-metrics.mjs`: пустующая ширина (W, WN, WE), пустующая высота и лишние
 * прокрутки (H, H2), действия строк вне колонки (C), строки внахлёст (V), ячейки
 * таблиц не на одной средней линии (R), последний элемент вплотную к низу окна и
 * тела диалога (B), своя стрелка выпадающего списка (S), переполнение (X),
 * слишком широкий текст (T).
 *
 * Каждый живой прогон начинается с самопроверки на заготовках с заведомыми
 * дефектами: замер, переставший видеть свой дефект, валит прогон раньше, чем
 * зелёный итог по разделам успеет что-то «доказать».
 *
 * Каждая ширина — отдельный замер той же открытой страницы (окно меняет размер,
 * страница не перезагружается), каждая тема — свой контекст браузера.
 *
 * Запуск (живой стенд `pnpm dev`, браузеры `pnpm qa:setup`):
 *   node tools/qa/audit-layout.mjs                      все разделы и их окна создания, 1280/1440/1920/2560, обе темы
 *   node tools/qa/audit-layout.mjs --quick              1440, светлая, без окон
 *   node tools/qa/audit-layout.mjs --only permissions   разделы, чей путь или имя содержит строку
 *   node tools/qa/audit-layout.mjs --no-modals          без окон создания (по умолчанию окно мерится:
 *                                                       тело длинного окна тоже обязано иметь воздух снизу, bug 10)
 *   node tools/qa/audit-layout.mjs --shots <dir>        снимок окна на каждый замер: <dir>/<ширина>-<тема>/<раздел>.png
 *   node tools/qa/audit-layout.mjs --inject-css "<css>" подмешать стиль (подать заведомо плохую вёрстку)
 *   node tools/qa/audit-layout.mjs --selftest           каждая метрика обязана назвать свой дефект
 * Код выхода 1 — нашлась хоть одна проблема (или самопроверка не поймала дефект).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { FIXTURES } from './layout-metrics.fixtures.mjs';
import { measureLayout } from './layout-metrics.mjs';
import { PANEL_PAGES, findCreateButton, openPanelPage, pageSlug } from './panel-pages.mjs';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Типичные экраны: высота — та, что встречается с этой шириной. */
const HEIGHT_FOR = { 1280: 800, 1440: 900, 1920: 1080, 2560: 1440 };
const widths = (option('--widths') ?? (flag('--quick') ? '1440' : '1280,1440,1920,2560'))
  .split(',')
  .map(Number);
const themes = (option('--themes') ?? (flag('--quick') ? 'light' : 'light,dark')).split(',');
const only = option('--only');
const shotsDir = option('--shots');
const injectCss = option('--inject-css');
const withModals = flag('--modals') || (!flag('--no-modals') && !flag('--quick'));

const browser = await chromium.launch();

/** Самопроверка: каждая заготовка с дефектом названа своей метрикой, и только ею. */
async function selftest(verbose) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let missed = 0;
  for (const fixture of FIXTURES) {
    await page.setContent(fixture.html);
    const { issues } = await page.evaluate(measureLayout, {});
    const codes = new Set(issues.map((issue) => issue.code));
    const lacking = fixture.expect.filter((code) => !codes.has(code));
    // Лишняя метрика на заведомом дефекте — тоже промах: значит, либо каркас
    // случая кривой, либо замер путает дефекты между собой.
    const unexpected = issues.filter((issue) => !fixture.expect.includes(issue.code));
    const ok = lacking.length === 0 && unexpected.length === 0;
    if (!ok) missed += 1;
    const seen = issues.map((issue) => `${issue.code}: ${issue.text}`).join(' | ') || '—';
    if (verbose || !ok) console.log(`${ok ? 'ок ' : 'ПРОМАХ'} ${fixture.name} → ${seen}`);
  }
  await page.close();
  console.log(
    missed
      ? `\nСамопроверка: ${missed} из ${FIXTURES.length} случаев не пойманы.`
      : `${verbose ? '\n' : ''}Самопроверка: все ${FIXTURES.length} случаев пойманы.`,
  );
  return missed;
}

if (flag('--selftest')) {
  const missed = await selftest(true);
  await browser.close();
  process.exit(missed ? 1 : 0);
}
if ((await selftest(false)) > 0) {
  await browser.close();
  process.exit(1);
}

/** Дождаться конца анимаций появления (бесконечные — спиннеры — не ждём). */
async function settle(page) {
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => null)),
        ),
        new Promise((done) => setTimeout(done, 3000)),
      ]),
    )
    .catch(() => null);
  await page.waitForTimeout(150);
}

const entries = PANEL_PAGES.filter(
  (entry) => !only || entry.path.includes(only) || entry.name.includes(only),
);
// Фильтр, под который не подошёл ни один раздел, — не «проблем не найдено»:
// ноль замеров ничего не доказывает (Git Bash превращает `/hooks` в путь).
if (entries.length === 0) {
  console.log(`Ни один раздел не подошёл под --only «${only}» — мерить нечего.`);
  await browser.close();
  process.exit(2);
}
const problems = [];
const counts = {};
let unverified = 0;

for (const theme of themes) {
  const context = await browser.newContext({
    viewport: { width: widths[0], height: HEIGHT_FOR[widths[0]] ?? 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  await bypassOnboarding(page, { theme });

  for (const entry of entries) {
    const slug = pageSlug(entry.path, entry.slug);
    await page.setViewportSize({ width: widths[0], height: HEIGHT_FOR[widths[0]] ?? 900 });
    try {
      await openPanelPage(page, BASE_URL, entry);
      // Стенд перезапустился от чужой правки посреди загрузки — раздел показывает
      // окно «Панель не загрузилась», и замер мерил бы его, а не раздел.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const broken = await page
          .getByRole('dialog')
          .filter({ hasText: /не загрузилась|failed to load/i })
          .count();
        if (!broken) break;
        await page.waitForTimeout(3000);
        await openPanelPage(page, BASE_URL, entry);
      }
      // Скелет загрузки короче и уже данных: замер по нему судил бы не тот раздел.
      await page
        .waitForFunction(
          () =>
            ![...document.querySelectorAll('main [role="status"]')].some((node) =>
              /Загрузка|Loading/i.test(node.getAttribute('aria-label') ?? ''),
            ),
          null,
          { timeout: 12000 },
        )
        .catch(() => undefined);
      if (injectCss) await page.addStyleTag({ content: injectCss });
    } catch (error) {
      unverified += 1;
      console.log(
        `[${theme}] ${entry.name} — НЕ ПРОВЕРЕНО: ${String(error.message).split('\n')[0]}`,
      );
      continue;
    }

    for (const width of widths) {
      await page.setViewportSize({ width, height: HEIGHT_FOR[width] ?? 900 });
      await settle(page);
      const label = `[${theme} ${width}] ${entry.name} (${entry.path})`;
      let result;
      try {
        result = await page.evaluate(measureLayout, {});
      } catch (error) {
        unverified += 1;
        console.log(`${label} — НЕ ПРОВЕРЕНО: ${String(error.message).split('\n')[0]}`);
        continue;
      }
      // Нет <main>: стенд перезагрузился от чужой правки посреди замера. Раздел
      // открывается заново один раз; снова пусто — он не проверен, а не «сломан».
      if (result.issues.some((issue) => issue.code === 'E')) {
        await page.waitForTimeout(3000);
        await openPanelPage(page, BASE_URL, entry).catch(() => null);
        await settle(page);
        result = await page.evaluate(measureLayout, {}).catch(() => result);
        const still = result.issues.find((issue) => issue.code === 'E');
        if (still) {
          unverified += 1;
          console.log(`${label} — НЕ ПРОВЕРЕНО: ${still.text} и после повторного открытия`);
          continue;
        }
      }
      if (shotsDir) {
        const dir = join(shotsDir, `${width}-${theme}`);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `${slug}.png`) }).catch(() => null);
      }
      let issues = result.issues;

      if (withModals) {
        const create = await findCreateButton(page);
        if (create) {
          await create.click({ timeout: 3000 }).catch(() => null);
          const dialog = page.locator('[role="dialog"]').first();
          const opened = await dialog.waitFor({ state: 'visible', timeout: 2500 }).then(
            () => true,
            () => false,
          );
          if (opened) {
            await settle(page);
            const inDialog = await page.evaluate(measureLayout, {}).catch(() => ({ issues: [] }));
            const own = inDialog.issues.filter((issue) => /окна|таблица|пляшет/.test(issue.text));
            issues = issues.concat(own.map((issue) => ({ ...issue, text: `окно: ${issue.text}` })));
            if (shotsDir) {
              const dir = join(shotsDir, `${width}-${theme}`);
              await page.screenshot({ path: join(dir, `${slug}.dialog.png`) }).catch(() => null);
            }
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden', timeout: 2500 }).catch(() => null);
          }
        }
      }

      const unique = [...new Map(issues.map((issue) => [issue.code + issue.text, issue])).values()];
      if (unique.length === 0) continue;
      problems.push(`\n${label}`);
      for (const issue of unique.slice(0, 8)) {
        counts[issue.code] = (counts[issue.code] ?? 0) + 1;
        problems.push(`  · ${issue.code} ${issue.text}`);
      }
      if (unique.length > 8) problems.push(`  · … ещё ${unique.length - 8}`);
    }
  }
  await context.close();
}

await browser.close();

const measured = entries.length * widths.length * themes.length;
const summary = Object.entries(counts)
  .map(([code, count]) => `${code} ${count}`)
  .join(', ');
if (problems.length) console.log(problems.join('\n'));
console.log(
  `\nЗамеров: ${measured} (${entries.length} разделов × ${widths.join('/')} × ${themes.join('/')})` +
    (unverified ? `; НЕ проверено: ${unverified}` : '') +
    (summary ? `; проблемы по метрикам: ${summary}` : '; проблем вёрстки не найдено'),
);
process.exit(problems.length || unverified ? 1 : 0);
