/**
 * Кадры доски ядра (этап 12) для трёх документов справки:
 *   - `core/board` — доска, окно записи, окно задачи с перехватом и доработкой, открытый перехват,
 *     карточка лимита в окне задачи, плашка «Умолчания» над доской;
 *   - `core/queue` — «В очередь» и «Где остановиться» на экране запуска;
 *   - `groups/lanes` — полосы групп на доске, «Закрытые» с прежними запусками, «Импорт пунктов»;
 *   - `chat/limit` — карточка лимита в ленте чата и кнопка доски в шапке;
 *   - `chat/notes` — заметки к строкам правок в окне «Код проекта».
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель, своё ядро со своим
 * временным домом, прежние группы засеяны в `state.json` стенда (перевод «Пути» в окне импорта идёт
 * настоящей дорогой ядра). Ответы доски, вида задачи, разговора и окна кода подменены на границе
 * сети (`core-board-stubs.mjs`): живой журнал ядра такого набора карточек не держит. Ядру нужен
 * найденный CLI, чтобы стенд поднялся; модель кадрам не нужна.
 *
 * Варианты кадра (тема × язык) — одним прогоном: язык и тема — настройкой панели с перезагрузкой.
 *
 * Запуск: node tools/help-shots/core-board.mjs (ONLY=board,queue,lanes,limit,notes — часть сцен)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';
import { PROJECT, projectShell, settings } from './chat-stubs.mjs';
import {
  CHAT,
  IDS,
  boardCards,
  chatText,
  installBoardStub,
  installChatLimitStub,
  installCodeStub,
} from './core-board-stubs.mjs';

/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
// Ядру нужен найденный CLI, чтобы стенд поднялся; сам CLI кадрам не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;
const LEGACY_ID = '5d1c0b7e-0a9f-4c33-9a51-1f00c0de0b01';
const STEPS = [
  { ru: 'Собрать логи', en: 'Collect the logs' },
  { ru: 'Найти причину', en: 'Find the cause' },
  { ru: 'Починить парсер', en: 'Fix the parser' },
];
const L = {
  ru: {
    title: 'Название',
    request: 'Требования',
    repo: 'Путь к репозиторию',
    queue: 'В очередь',
    rework: 'Что доработать',
    reworkText: 'Добавь проверку пустой строки и тест на неё.',
    note: 'Что сделано (уйдёт следующему шагу)',
    noteText: 'Стили таблицы сведены в один модуль, тесты зелёные.',
    task: 'Свести стили таблицы',
    taskText: 'Свести стили таблицы заказов в один модуль.',
    codeButton: 'Код проекта',
    noteDraft: 'Что поправить в этой строке?',
    add: 'Добавить',
    notes: ['Разделитель берём из настройки, не литералом.', 'Пустая строка — ошибка с номером.'],
    projects: /^(Проекты)$/,
  },
  en: {
    title: 'Title',
    request: 'Requirements',
    repo: 'Repository path',
    queue: 'Queue',
    rework: 'What to rework',
    reworkText: 'Add an empty-line check and a test for it.',
    note: 'What was done (goes to the next step)',
    noteText: 'Table styles moved into one module, tests green.',
    task: 'Unify the table styles',
    taskText: 'Move the order table styles into one module.',
    codeButton: 'Project code',
    noteDraft: 'What to fix in this line?',
    add: 'Add',
    notes: [
      'Take the separator from the settings, not a literal.',
      'An empty line is an error with its number.',
    ],
    projects: /^(Projects)$/,
  },
};

let repo = '';
const stand = await startStand({
  label: 'core-board-help-shots',
  core: true,
  fakeCli: { claude: FAKE_CLAUDE },
  seed: ({ root, cfg }) => {
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'stand@example.com');
    git('config', 'user.name', 'stand');
    writeFileSync(join(repo, 'README.md'), '# Shop\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    const statePath = join(cfg, 'agentdeck', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.groups = [
      {
        id: LEGACY_ID,
        name: 'Log triage',
        description: 'Parser errors in the order service',
        color: 'accent',
        icon: 'folder',
        members: [],
        env: {},
        flow: 'scenario',
        path: {
          steps: STEPS.map((title, order) => ({
            id: `step-${order}`,
            anchor: 'work',
            order,
            kind: 'prompt',
            title,
            prompt: { ru: `Сделать: ${title.ru}`, en: `Do: ${title.en}` },
            source: 'ru',
            createdAt: '2026-10-01T00:00:00.000Z',
          })),
        },
        isEnabled: false,
        order: 0,
      },
    ];
    state.splitPlans = {
      'legacy-done': {
        parentChatId: 'legacy-done',
        projectPath: repo,
        createdAt: '2026-10-20T09:00:00.000Z',
        order: [0],
        request: {},
        proposal: {
          shared: 'legacy',
          groups: [{ title: 'Parser fix', branch: 'feat/parser-fix', tasks: ['x'] }],
        },
        groups: [
          { index: 0, title: 'Parser fix', branch: 'feat/parser-fix', after: [], status: 'done' },
        ],
      },
    };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');
  },
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

/** Окно карточки выше экрана прокручивается внутри: довести до раздела, о котором кадр. */
async function reveal(page, selector, { bottom = false } = {}) {
  await page
    .locator(selector)
    .first()
    .evaluate((node, toBottom) => {
      node.scrollIntoView({ block: 'end' });
      if (!toBottom) return;
      // До конца окна: под разделом стоит ещё «Где остановиться».
      let box = node.parentElement;
      while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
      if (box) box.scrollTop = box.scrollHeight;
    }, bottom);
  await wait(300);
}

async function openCard(page, cardId) {
  await page.locator(`[data-board-card="${cardId}"]`).first().click();
  await page.locator(`[data-card-modal="${cardId}"]`).waitFor({ timeout: 20_000 });
  await wait(800);
}

async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.locator('[data-card-modal]').waitFor({ state: 'detached', timeout: 10_000 });
}

async function shootBoard(page, variant, boardState) {
  const t = L[variant.lang];
  const scenario = openScenario('core', 'board', variant.lang, variant.theme);
  boardState.configIssues = false;
  await toVariant(page, variant, `${stand.webUrl}/core?view=board`);
  await page.locator('[data-board-columns]').waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '01-board', '[data-core-board]');

  await openCard(page, IDS.inbox);
  await shotArea(scenario, page, '02-entry-window', '[role="dialog"]');
  await closeModal(page);

  await openCard(page, IDS.work);
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByLabel(t.rework, { exact: true }).fill(t.reworkText);
  await reveal(page, '[data-takeover-rework]', { bottom: true });
  await shotArea(scenario, page, '03-task-window', '[role="dialog"]');
  await closeModal(page);

  await openCard(page, IDS.takeover);
  await dialog.getByLabel(t.note, { exact: true }).fill(t.noteText);
  await reveal(page, '[data-takeover-handback]');
  await shotArea(scenario, page, '04-takeover-open', '[role="dialog"]');
  await closeModal(page);

  await openCard(page, IDS.window);
  await page.locator('[data-limit-card]').waitFor({ timeout: 20_000 });
  await reveal(page, '[data-limit-card]');
  await shotArea(scenario, page, '05-window-card', '[role="dialog"]');
  await closeModal(page);

  boardState.configIssues = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-board-config-issues]').waitFor({ timeout: 30_000 });
  // Ряд лимитов и строка про отвергнутый раздел под ним — общий родитель обоих.
  await shotArea(scenario, page, '06-defaults', 'div:has(> [data-board-limits])', 16);
  boardState.configIssues = false;
  scenario.finish();
}

async function shootQueue(page, variant) {
  const t = L[variant.lang];
  const scenario = openScenario('core', 'queue', variant.lang, variant.theme);
  await toVariant(page, variant, `${stand.webUrl}/core/launch`);
  const form = page.locator('[data-core-launch-form]').first();
  await form.waitFor({ timeout: 60_000 });
  await form.getByLabel(t.title, { exact: true }).fill(t.task);
  await form.getByLabel(t.request, { exact: true }).fill(t.taskText);
  const repoField = form.getByLabel(t.repo, { exact: true }).first();
  // Запись «В очередь» подменена на границе сети — путь в кадре нейтральный, не путь стенда.
  await repoField.fill(PROJECT.path);
  await form.locator('[data-queue-button]').click();
  await page.locator('[data-queue-done]').waitFor({ timeout: 20_000 });
  await shotArea(scenario, page, '01-queue', '[data-core-launch-form]');
  scenario.finish();
}

async function shootLanes(page, variant) {
  const scenario = openScenario('groups', 'lanes', variant.lang, variant.theme);
  await toVariant(page, variant, `${stand.webUrl}/core?view=board&lane=group`);
  await page.locator('[data-board-lane]').first().waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '01-lanes', '[data-core-board]');

  await page.locator('[data-board-closed-toggle]').first().click();
  await page.locator('[data-legacy-run]').first().waitFor({ timeout: 30_000 });
  await shotArea(scenario, page, '02-closed', '[data-board-closed]');

  await page.locator('[data-board-import]').first().click();
  await page.locator('[data-board-import-group]').first().waitFor({ timeout: 30_000 });
  await shotArea(scenario, page, '03-import-pick', '[role="dialog"]');
  await page.locator('[data-board-import-group] button').first().click();
  await page.locator('[data-core-import-step]').first().waitFor({ timeout: 30_000 });
  await shotArea(scenario, page, '04-import-steps', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await wait(500);
  scenario.finish();
}

/** Открыть вкладку проекта и разговор. */
async function openProjectChat(page, variant) {
  const t = L[variant.lang];
  await toVariant(page, variant, `${stand.webUrl}/chat`);
  await page.waitForSelector('nav');
  await wait(1500);
  await closeAccessDialog(page);
  const tab = page.getByRole('tab', { name: t.projects });
  if (await tab.count()) await tab.click();
  await wait(800);
  const project = page.getByRole('button', { name: new RegExp(PROJECT.name) }).first();
  if (await project.count()) await project.click();
  await wait(1500);
  await page
    .getByRole('button', { name: new RegExp(chatText(variant.lang).title) })
    .first()
    .click();
  await page.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
  await page.getByText(chatText(variant.lang).answer).first().waitFor({ timeout: 20_000 });
  await closeAccessDialog(page);
}

/** Окно «нужен доступ» ассистента форм закрываем так же, как человек: оно прячет от ролей всё под собой. */
async function closeAccessDialog(page) {
  const blocking = page.getByRole('dialog').filter({ hasText: /нужен доступ|needs access/ });
  if (!(await blocking.count())) return;
  await page.keyboard.press('Escape');
  await blocking.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
}

async function shootChatLimit(page, variant) {
  const scenario = openScenario('chat', 'limit', variant.lang, variant.theme);
  await openProjectChat(page, variant);
  const input = page.locator('textarea[data-chat-input]');
  await input.fill(chatText(variant.lang).next);
  await input.press('Enter');
  await page.locator('[data-chat-limit-offer]').first().waitFor({ timeout: 30_000 });
  await shotArea(scenario, page, '01-limit-card', '[data-chat-limit]', 24);
  await shotArea(
    scenario,
    page,
    '02-board-button',
    '[class*="_headRow"]:has([data-chat-board])',
    8,
  );
  scenario.finish();
}

async function shootNotes(page, variant) {
  const t = L[variant.lang];
  const scenario = openScenario('chat', 'notes', variant.lang, variant.theme);
  await openProjectChat(page, variant);
  await page.getByRole('button', { name: t.codeButton }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.cm-diff-notes-gutter').waitFor({ timeout: 30_000 });
  for (const [index, line] of [2, 3].entries()) {
    await dialog.locator(`[data-note-line="${line}"]`).first().click();
    await dialog.locator('[data-testid="diff-note-draft"]').fill(t.notes[index]);
    await dialog.getByRole('button', { name: t.add, exact: true }).click();
    await wait(400);
  }
  await dialog.locator('[data-testid="diff-notes-tray"]').waitFor({ timeout: 10_000 });
  await shotArea(scenario, page, '01-notes', '[role="dialog"]');
  await page.keyboard.press('Escape');
  scenario.finish();
}

// ONLY=board,queue,lanes,limit,notes — переснять часть сцен; без него снимаются все.
const ONLY = process.env.ONLY?.split(',').filter(Boolean) ?? [];
const wanted = (scene) => ONLY.length === 0 || ONLY.includes(scene);

let exitCode = 0;
const browser = await chromium.launch();
try {
  const boardState = { lang: 'ru', configIssues: false };
  // Высота — чтобы окно карточки с перехватом и точкой остановки вошло целиком, без прокрутки.
  const boardPage = await stand.newPage(browser, { width: 1920, height: 1500 });
  await installBoardStub(boardPage, boardState);
  const chatState = { lang: 'ru' };
  const chatPage = await stand.newPage(browser, { width: 1500, height: 1000 });
  await settings(chatPage);
  await projectShell(chatPage);
  await installChatLimitStub(chatPage, chatState);
  await installCodeStub(chatPage);
  // Доска стенда — подменная: проверка, что подмена отдаёт ровно то, что задумано.
  console.log(`карточек на доске: ${boardCards('ru').length}, разговор ${CHAT}`);

  for (const variant of SHOT_VARIANTS) {
    console.log(`\nвариант ${variant.key}`);
    boardState.lang = variant.lang;
    chatState.lang = variant.lang;
    if (wanted('board')) await shootBoard(boardPage, variant, boardState);
    if (wanted('queue')) await shootQueue(boardPage, variant);
    if (wanted('lanes')) await shootLanes(boardPage, variant);
    if (wanted('limit')) await shootChatLimit(chatPage, variant);
    if (wanted('notes')) await shootNotes(chatPage, variant);
  }
  for (const page of [boardPage, chatPage]) {
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
