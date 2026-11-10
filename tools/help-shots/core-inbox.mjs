/**
 * Кадры этапа 12, волна 2 — входящие из трекера, «На доску» у красного кейса и Telegram с ядром:
 *   - `core/inbox` — строка «Входящие из трекера», окно «Источники», «Найти в трекере», выбор
 *     «Сценарий» у записи из трекера;
 *   - `tests/board` — раскрытый прогон с кнопкой «На доску» у красного кейса;
 *   - `integrations/telegram-core` — «Отвечать ядру из Telegram», репозитории для /task, тихие часы.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель и своё ядро во временном
 * доме. Ответы ядра (настройка, поиск, доска), раздела «Тесты» и карточки Telegram подменены на
 * границе сети — теми же подменами, что гоняют проверки `tools/qa/check-core-inbox.mjs` и
 * `telegram-card-stub.mjs`; доска — локализованная подмена справки (`core-board-stubs.mjs`).
 * Ни настоящего трекера, ни бота, ни настоящего проекта.
 *
 * Запуск: node tools/help-shots/core-inbox.mjs (ONLY=inbox,tests,telegram — часть сцен)
 */
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import {
  INBOX_ITEMS,
  TESTS_PROJECT,
  installCoreInboxStub,
  installTestsRunStub,
} from '../qa/check-core-inbox.mjs';
import { installTelegramCardStub } from '../qa/telegram-card-stub.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';
import { PROJECT } from './chat-stubs.mjs';
import { IDS, LIMITS, boardCards, installBoardStub } from './core-board-stubs.mjs';

/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
// Ядру нужен найденный CLI, чтобы стенд поднялся; сам CLI кадрам не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const wanted = (scene) => ONLY.length === 0 || ONLY.includes(scene);

const L = {
  ru: {
    tickets: ['Проверить вход по ссылке', 'Кнопка «Сохранить» не гаснет', 'Экспорт заказов в CSV'],
    entry: 'PROJ-1: экспорт заказов в CSV',
    cases: ['Вход существующим пользователем', 'Выход', 'Настройки'],
    note: 'кнопка осталась активной',
    expected: 'кнопка выключена',
    actual: 'кнопка активна',
    project: 'Панель заказов',
  },
  en: {
    tickets: ['Check the login link', 'The Save button stays enabled', 'Export orders to CSV'],
    entry: 'PROJ-1: export orders to CSV',
    cases: ['Log in as an existing user', 'Log out', 'Settings'],
    note: 'the button stayed enabled',
    expected: 'the button is disabled',
    actual: 'the button is enabled',
    project: 'Orders panel',
  },
};

/** Настройка ядра: Jira с метками и «назначенные на меня», GitLab выключен — MR на ревью. */
const INBOX_DOC = {
  v: 1,
  inbox: {
    sources: [
      {
        id: 'jira',
        system: 'jira',
        enabled: true,
        repos: { 'shop/orders-panel': PROJECT.path },
        autoQueue: false,
        jira: { labels: ['agent'], assignedToMe: true },
      },
      {
        id: 'gitlab',
        system: 'gitlab',
        enabled: false,
        repos: { 'shop/orders-panel': PROJECT.path },
        autoQueue: false,
        gitlab: {
          issues: { labels: [], assignedToMe: false },
          reviewerMrs: true,
          ownMrsWithThreads: false,
        },
      },
    ],
  },
};

const stand = await startStand({
  label: 'core-inbox-help-shots',
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
  // Ошибка сборки фронта стенда (чужая правка на полпути) закрывает страницу плашкой Vite: кадр
  // с ней — не кадр, а клики под ней не доходят. Падаем с её текстом.
  const overlay = page.locator('vite-error-overlay');
  if (await overlay.count()) {
    const text = await overlay.evaluate((node) => node.shadowRoot?.textContent ?? '');
    throw new Error(`фронт стенда не собрался: ${text.slice(0, 600)}`);
  }
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 60_000 });
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.mouse.move(2, 2);
  await wait(600);
  await scenario.shot(page, frameId, { clip: selector, padding, maskText: MASKS });
}

/**
 * Страница доски: подмена входящих (настройка, поиск, заведение), поверх — локализованная доска
 * справки, а поверх неё — сама доска с записью из трекера, у которой разрешён ход `set-preset`.
 * Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему обработчику; чужие пути идут дальше по цепочке.
 */
async function inboxPage(browser, state) {
  const page = await stand.newPage(browser, { width: 1920, height: 1300 });
  await installCoreInboxStub(page, INBOX_DOC);
  await installBoardStub(page, state);
  await page.route(/\/api\/core\/board(\?|$)/, (route) => {
    const t = L[state.lang];
    const cards = boardCards(state.lang).map((card) =>
      card.entryId === IDS.inbox
        ? {
            ...card,
            title: t.entry,
            preset: 'tracker-ticket',
            moves: [...card.moves, 'set-preset'],
            source: {
              kind: 'tracker',
              system: 'jira',
              key: 'PROJ-1',
              url: 'https://tracker.example.com/browse/PROJ-1',
              title: t.entry,
            },
          }
        : card,
    );
    return route.fulfill({ json: { cards, entries: [], limits: LIMITS } });
  });
  await page.route(/\/api\/core\/inbox\/search(\?|$)/, (route) => {
    const t = L[state.lang];
    const items = INBOX_ITEMS.map((item, i) => ({
      ...item,
      title: t.tickets[i],
      labels: ['agent'],
    }));
    return route.fulfill({ json: { items, truncated: false } });
  });
  return page;
}

async function shootInbox(page, variant) {
  const scenario = openScenario('core', 'inbox', variant.lang, variant.theme);
  await toVariant(page, variant, `${stand.webUrl}/core?view=board`);
  await page.locator('[data-board-inbox-sources="2"]').waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '01-row', '[data-board-inbox]');

  await page.locator('[data-board-inbox-open="sources"]').click();
  await page.locator('[data-inbox-source-index="1"]').waitFor({ timeout: 20_000 });
  // Окно целиком, с заголовком и прокруткой в начале: первым виден источник Jira.
  await shotArea(scenario, page, '02-sources', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await page.locator('[data-inbox-sources]').waitFor({ state: 'detached', timeout: 10_000 });

  await page.locator('[data-board-inbox-open="search"]').click();
  const search = page.locator('[data-inbox-search]');
  await search.locator('[data-inbox-search-run]').click();
  const items = search.locator('[data-inbox-item]');
  await items.first().waitFor({ timeout: 20_000 });
  // Две отметки из трёх — кадр показывает выбор и счёт кнопки «Во входящие (2)».
  for (const at of [0, 2]) await items.nth(at).locator('input[type="checkbox"]').check();
  await shotArea(scenario, page, '03-search', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached', timeout: 10_000 });

  await page.locator(`[data-board-card="${IDS.inbox}"]`).first().click();
  await page.locator('[data-entry-preset]').waitFor({ timeout: 20_000 });
  await shotArea(scenario, page, '04-preset', '[role="dialog"]');
  await page.keyboard.press('Escape');
  scenario.finish();
}

/** Раздел «Тесты» на подмене прогона; тексты кейсов — на языке варианта. */
async function testsPage(browser, state) {
  const page = await stand.newPage(browser, { width: 1600, height: 1100 });
  await installBoardStub(page, state);
  await installTestsRunStub(page);
  await page.route('**/api/project-tests?*', (route) => {
    const t = L[state.lang];
    return route.fulfill({
      json: {
        projectPath: TESTS_PROJECT.path,
        dir: '.agent/tests',
        hasConvention: true,
        sharedSteps: [],
        environments: [],
        schema: { attributes: [], statuses: [] },
        views: [],
        plans: [],
        branch: 'main',
        groups: [
          {
            id: 'gui',
            title: 'GUI',
            file: '.agent/tests/gui.tests.json',
            cases: t.cases.map((title, i) => ({
              id: `gui-00${i + 1}`,
              type: 'case',
              title,
              steps: [],
              status: ['failed', 'passed', 'blocked'][i],
              source: 'agent',
            })),
          },
        ],
      },
    });
  });
  const run = (lang) => {
    const t = L[lang];
    return {
      id: 'run-inbox-1',
      mode: 'run',
      actor: 'agent',
      status: 'done',
      environmentId: 'local',
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: '2026-11-08T10:20:00.000Z',
      results: [
        {
          pointId: 'gui|gui-001|local',
          groupId: 'gui',
          caseId: 'gui-001',
          status: 'failed',
          note: t.note,
          failure: { step: 2, expected: t.expected, actual: t.actual },
        },
        { pointId: 'gui|gui-002|local', groupId: 'gui', caseId: 'gui-002', status: 'passed' },
        { pointId: 'gui|gui-003|local', groupId: 'gui', caseId: 'gui-003', status: 'blocked' },
      ],
      summary: { total: 3, passed: 1, failed: 1, skipped: 0, blocked: 1 },
    };
  };
  await page.route(/\/api\/project-tests\/run(\?|$)/, (route) =>
    route.fulfill({ json: { run: run(state.lang) } }),
  );
  await page.route(/\/api\/project-tests\/runs(\?|$)/, (route) =>
    route.fulfill({ json: { runs: [run(state.lang)] } }),
  );
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: TESTS_PROJECT.path,
          name: L[state.lang].project,
          exists: true,
          lastActivity: '2026-11-08T10:00:00.000Z',
          chats: [],
        },
      ],
    }),
  );
  return page;
}

async function shootTests(page, variant) {
  const scenario = openScenario('tests', 'board', variant.lang, variant.theme);
  await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ project, name }) => {
      const id = project.path.toLowerCase();
      localStorage.setItem(
        'agentdeck:workspace',
        JSON.stringify({
          projectTabs: [{ id, path: project.path, name }],
          activeTabId: id,
          views: {},
        }),
      );
      localStorage.setItem('agentdeck:tests-project', id);
    },
    { project: TESTS_PROJECT, name: L[variant.lang].project },
  );
  await toVariant(page, variant, `${stand.webUrl}/tests?tab=runs`);
  const head = page.locator('[id^="run-card-"] button[aria-expanded]').first();
  await head.waitFor({ timeout: 60_000 });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await page.locator('[data-tests-to-board="gui:gui-001"]').waitFor({ timeout: 20_000 });
  await shotArea(scenario, page, '01-to-board', '[id^="run-card-"]');
  scenario.finish();
}

/** Карточка Telegram «подключена»: привязка ядра, репозитории проекта справки, тихие часы. */
async function telegramPage(browser) {
  const page = await stand.newPage(browser, { width: 1500, height: 1300 });
  const state = await installTelegramCardStub(page);
  state.doc = {
    telegram: { ...state.doc.telegram, repos: [{ path: PROJECT.path, baseRef: 'main' }] },
  };
  return page;
}

async function shootTelegram(page, variant) {
  const scenario = openScenario('integrations', 'telegram-core', variant.lang, variant.theme);
  await toVariant(page, variant, `${stand.webUrl}/settings?tab=integrations`);
  await page.locator('[data-telegram-repos]').waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '01-binding', '[data-telegram-core-binding]');
  await shotArea(scenario, page, '02-repos', '[data-telegram-repos]');
  await shotArea(scenario, page, '03-quiet', '[data-telegram-quiet]');
  scenario.finish();
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const boardState = { lang: 'ru', configIssues: false };
  const pages = [];
  const core = wanted('inbox') ? await inboxPage(browser, boardState) : null;
  const tests = wanted('tests') ? await testsPage(browser, boardState) : null;
  const telegram = wanted('telegram') ? await telegramPage(browser) : null;
  for (const page of [core, tests, telegram]) if (page) pages.push(page);

  for (const variant of SHOT_VARIANTS) {
    console.log(`\nвариант ${variant.key}`);
    boardState.lang = variant.lang;
    if (core) await shootInbox(core, variant);
    if (tests) await shootTests(tests, variant);
    if (telegram) await shootTelegram(telegram, variant);
  }
  for (const page of pages) {
    if (page.errors.length) console.log(`ошибки страницы: ${page.errors.join(' | ')}`);
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
