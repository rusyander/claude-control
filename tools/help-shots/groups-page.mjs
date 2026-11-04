/**
 * Кадры документа «Группы» (`groups/page`): страница групп над ядром — задачи ядра, прежние запуски
 * групп, сетка «Прежние группы» только для чтения и окно «В ядро».
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель, своё ядро со своим
 * временным домом; прежние группы и прежние запуски засеяны в `state.json` стенда. Ответы панели и
 * ядра не подменяются: перевод «Пути» (`fromPath`), запись сценария и оценка идут настоящей дорогой
 * через прокладку `/api/core/*`. Подменён только CLI — ядру нужен найденный `claude`, чтобы дорога
 * прошла; модель кадрам не нужна. Недоведённый прежний запуск отменяет сама панель при старте
 * (разовая миграция), поэтому в кадре он «Отменён».
 *
 * Задача ядра создаётся ОДИН раз до вариантов (через «В ядро» → запуск → оценка), дальше каждый
 * вариант (тема × язык) только перезагружает страницу и снимает — список задач во всех кадрах один.
 *
 * Запуск: node tools/help-shots/groups-page.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';

const TOPIC = 'groups';
const SCENARIO = 'page';
/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
// Ядру нужен найденный CLI, чтобы дорога `cli` прошла; сам CLI кадрам не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

const TRIAGE_ID = '5d1c0b7e-0a9f-4c33-9a51-1f00c0de0a01';
const REVIEW_ID = '5d1c0b7e-0a9f-4c33-9a51-1f00c0de0a02';
const TRIAGE = 'Log triage';
const STEPS = [
  { ru: 'Собрать логи', en: 'Collect the logs' },
  { ru: 'Найти причину', en: 'Find the cause' },
  { ru: 'Починить парсер', en: 'Fix the parser' },
  { ru: 'Добавить тест', en: 'Add a test' },
  { ru: 'Описать итог', en: 'Write the summary' },
];
const LABELS = {
  ru: { request: 'Требования', repo: 'Путь к репозиторию' },
  en: { request: 'Requirements', repo: 'Repository path' },
};

function pathSteps() {
  return STEPS.map((title, order) => ({
    id: `step-${order}`,
    anchor: 'work',
    order,
    kind: 'prompt',
    title,
    prompt: { ru: `Сделать: ${title.ru}`, en: `Do: ${title.en}` },
    source: 'ru',
    createdAt: '2026-10-01T00:00:00.000Z',
  }));
}

function group(id, name, description, steps) {
  return {
    id,
    name,
    description,
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    flow: 'scenario',
    ...(steps ? { path: { steps } } : {}),
    isEnabled: false,
    order: id === TRIAGE_ID ? 0 : 1,
  };
}

/** Прежний запуск: `statuses` — статусы групп плана; недоведённый панель отменит при старте. */
function plan(chat, repo, createdAt, titles, statuses) {
  const groups = titles.map((title, index) => ({
    index,
    title,
    branch: `feat/${title.toLowerCase().replace(/\W+/g, '-')}`,
    after: [],
    status: statuses[index],
  }));
  return {
    parentChatId: chat,
    projectPath: repo,
    createdAt,
    order: groups.map((g) => g.index),
    request: {},
    proposal: {
      shared: 'legacy request',
      groups: groups.map((g) => ({ title: g.title, branch: g.branch, tasks: ['legacy'] })),
    },
    groups,
  };
}

let repo = '';
const stand = await startStand({
  label: 'groups-help-shots',
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
      group(TRIAGE_ID, TRIAGE, 'Parser errors in the order service', pathSteps()),
      group(REVIEW_ID, 'Code review', 'Review rules and skills, no Path steps'),
    ];
    state.splitPlans = {
      'legacy-done': plan(
        'legacy-done',
        repo,
        '2026-10-20T09:00:00.000Z',
        ['Parser fix', 'Release notes'],
        ['done', 'done'],
      ),
      'legacy-half': plan(
        'legacy-half',
        repo,
        '2026-10-30T10:00:00.000Z',
        ['Checkout form', 'Payment retry'],
        ['started', 'done'],
      ),
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

/** Кадр области: прокрутить к ней (у панели своя прокрутка) и снять с полями. */
async function shotArea(scenario, page, id, selector, padding = 16) {
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 60_000 });
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.mouse.move(2, 2);
  await wait(500);
  await scenario.shot(page, id, { clip: selector, padding, maskText: MASKS });
}

function triageTile(page) {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: TRIAGE, exact: true }) });
}

/** «В ядро» у карточки и окно со шагами перевода (ответ ядра — настоящий). */
async function openImport(page) {
  await triageTile(page).locator('[data-group-core-import]').click();
  const dialog = page.locator('[data-core-import]');
  await dialog.waitFor({ timeout: 20_000 });
  await dialog.locator('[data-core-import-step]').first().waitFor({ timeout: 20_000 });
  return dialog;
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  // `claude.cmd` формы npm cmd-shim (её одну ядро разбирает на Windows) пишет сам стенд.
  const page = await stand.newPage(browser, { width: 1440, height: 1600 });
  const url = `${stand.webUrl}/groups?tab=global`;

  // ── Одна задача ядра — «В ядро» → запуск → оценка (настройка кадров, светлый русский) ──────
  await toVariant(page, SHOT_VARIANTS[0], url);
  await openImport(page);
  await page.locator('[data-core-import-save]').click();
  const form = page.locator('[data-groups-core] [data-core-launch-form]');
  await form.waitFor({ timeout: 20_000 });
  await form.getByLabel(LABELS.ru.request, { exact: true }).fill('Fix the parser errors.');
  const repoField = form.getByLabel(LABELS.ru.repo, { exact: true }).first();
  if (!(await repoField.inputValue())) await repoField.fill(repo);
  await page.locator('[data-groups-core] [data-estimate-button]').click();
  const task = page.locator('[data-groups-core] [data-core-task]').first();
  await task.waitFor({ timeout: 60_000 });
  const half = (await stand.api('/groups/legacy-runs')).body;
  console.log(`прежние запуски: ${JSON.stringify(half?.runs?.map((r) => r.state) ?? half)}`);

  for (const variant of SHOT_VARIANTS) {
    console.log(`\nсценарий ${TOPIC}/${SCENARIO} [${variant.key}]`);
    await toVariant(page, variant, url);
    const scenario = openScenario(TOPIC, SCENARIO, variant.lang, variant.theme);
    await page.locator('[data-groups-core] [data-core-task]').first().waitFor({ timeout: 60_000 });
    await page.locator('[data-legacy-run]').first().waitFor({ timeout: 30_000 });
    await triageTile(page).waitFor({ timeout: 30_000 });
    // Раздел ядра несёт и задачи, и прежние запуски групп — один кадр на оба.
    await shotArea(scenario, page, '01-core-tasks', '[data-groups-core]');
    await shotArea(scenario, page, '02-legacy-grid', '[data-groups-legacy]');
    await openImport(page);
    await shotArea(scenario, page, '03-core-import', '[role="dialog"]');
    await page.keyboard.press('Escape');
    await page.locator('[data-core-import]').waitFor({ state: 'detached', timeout: 10_000 });
    scenario.finish();
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
