/**
 * Кадры этапа 12, волна 3 — связанные карточки доски ядра (B11, P186), документ «Ядро задач»:
 *   - `core/related` — значок «связано: 1» на плитках «Входящих», раздел «Связанные карточки» в окне
 *     записи с «Объединить в эту (1)», отказ ядра одной строкой с ключом тикета.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель и своё ядро во временном
 * доме. Доска — локализованная подмена справки (`core-board-stubs.mjs`), поверх неё — связанная
 * пара записей трекера и ход `merge`, отвечающий телом отказа `board-move.ts` (та же форма, что
 * у `tools/qa/check-core-board.mjs` в режиме `related`). Ни трекера, ни настоящего проекта.
 *
 * Запуск: node tools/help-shots/core-related.mjs
 */
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';
import { LIMITS, boardCards, installBoardStub } from './core-board-stubs.mjs';

/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
// Ядру нужен найденный CLI, чтобы стенд поднялся; сам CLI кадрам не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

const PAIR = {
  first: '01900000-0000-7000-8000-0000000f0001',
  second: '01900000-0000-7000-8000-0000000f0002',
};
const TICKETS = {
  ru: { first: 'PROJ-10 Форма входа', second: 'PROJ-11 Ошибки входа' },
  en: { first: 'PROJ-10 Login form', second: 'PROJ-11 Login errors' },
};
/** Проза отказа ядра — как у `moves.ts` applyMerge, когда запись ушла в очередь. */
const REFUSAL = `entry ${PAIR.second} (PROJ-11) is queued: only inbox entries merge`;

function pairEntry(lang, key, other) {
  const title = TICKETS[lang][key];
  return {
    kind: 'entry',
    id: PAIR[key],
    entryId: PAIR[key],
    column: 'inbox',
    state: 'inbox',
    title,
    stop: 'plan',
    preset: 'tracker-ticket',
    waiting: false,
    questions: 0,
    takeover: null,
    createdAt: Date.UTC(2026, 10, 8, 9, 0, 0),
    source: { kind: 'tracker', key: title.split(' ')[0], title },
    moves: ['queue', 'rejected', 'merge'],
    related: [{ entryId: PAIR[other], title: TICKETS[lang][other], reasons: ['epic', 'path'] }],
  };
}

/** Доска справки + связанная пара трекера в начале «Входящих»; запись без связи остаётся ниже. */
function relatedBoard(lang) {
  return [
    pairEntry(lang, 'first', 'second'),
    pairEntry(lang, 'second', 'first'),
    ...boardCards(lang),
  ];
}

/** Поверх подмены доски: `/board` с парой и `merge`, который отказывает (кадр отказа). */
async function installRelatedStub(page, state) {
  await page.route(/\/api\/core\/board(\/move)?(\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/board') {
      return route.fulfill({
        json: { cards: relatedBoard(state.lang), entries: [], limits: LIMITS },
      });
    }
    if (path === '/board/move' && request.method() === 'POST') {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Ход доски не разрешён',
          code: 'move-not-allowed',
          allowed: ['queue', 'rejected', 'merge'],
          reason: REFUSAL,
        },
      });
    }
    return route.fallback();
  });
}

const stand = await startStand({
  label: 'core-related-help-shots',
  core: true,
  fakeCli: { claude: FAKE_CLAUDE },
});

async function toVariant(page, variant, url) {
  await applyShotLanguage(stand.apiUrl, variant.lang, variant.theme);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    ([lang, theme]) =>
      document.documentElement.lang.startsWith(lang) &&
      document.documentElement.dataset.theme === theme,
    [variant.lang, variant.theme],
    { timeout: 90_000 },
  );
}

/** Кадр области: прокрутить к ней, увести указатель и снять с полями. */
async function shotArea(scenario, page, frameId, selector, padding = 16) {
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 60_000 });
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.mouse.move(2, 2);
  await wait(600);
  await scenario.shot(page, frameId, { clip: selector, padding, maskText: MASKS });
}

async function shootRelated(page, variant) {
  const scenario = openScenario('core', 'related', variant.lang, variant.theme);
  await toVariant(page, variant, `${stand.webUrl}/core?view=board`);
  await page.locator('[data-board-columns]').waitFor({ timeout: 60_000 });
  await page.locator(`[data-board-card="${PAIR.first}"] [data-board-related]`).waitFor();
  await shotArea(scenario, page, '01-chip', '[data-board-column="inbox"]');

  await page.locator(`[data-board-card="${PAIR.first}"]`).first().click();
  const modal = page.locator(`[data-card-modal="${PAIR.first}"]`);
  await modal.locator('[data-related-merge]').waitFor({ timeout: 20_000 });
  await modal
    .locator('[data-related-merge]')
    .evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await shotArea(scenario, page, '02-merge', '[data-related-merge]');

  await modal.locator('[data-related-merge-submit]').click();
  await modal.locator('[data-related-merge-refused]').waitFor({ timeout: 10_000 });
  await shotArea(scenario, page, '03-refused', '[data-related-merge]');
  await page.keyboard.press('Escape');
  await page.locator('[data-card-modal]').waitFor({ state: 'detached', timeout: 10_000 });
  scenario.finish();
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const state = { lang: 'ru', configIssues: false };
  const page = await stand.newPage(browser, { width: 1920, height: 1300 });
  await installBoardStub(page, state);
  await installRelatedStub(page, state);
  for (const variant of SHOT_VARIANTS) {
    console.log(`\nвариант ${variant.key}`);
    state.lang = variant.lang;
    await shootRelated(page, variant);
  }
  if (page.errors.length) console.log(`ошибки страницы: ${page.errors.join(' | ')}`);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
