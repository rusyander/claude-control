/**
 * Кадры справки «Тесты» → «Сценарии» (этап 12, R3–R4) — сценарий `tests/recorded`:
 *   - `01-list` — вкладка с двумя записанными проходами, полоской прогонов и строкой «все прошли»;
 *   - `02-record` — окно «Записать сценарий» после прохода: итог, имя, группа;
 *   - `03-mismatch` — карточка первого расхождения с выбором человека;
 *   - `04-rerecord` — сценарий отмечен устаревшим, «Перезаписать из прохода» открыта.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`): своя панель во временном доме. Ответы
 * раздела «Тесты», записанных проходов и строк прохода ядра подменены на границе сети той же
 * подменой, что гоняет проверку `tools/qa/check-tests-recorded.mjs`; тексты — на языке варианта.
 * Ни настоящего проекта, ни ядра, ни модели.
 *
 * Запуск: node tools/help-shots/tests-recorded.mjs
 */
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { installRecordedStub } from '../qa/check-tests-recorded.mjs';
import { TESTS_PROJECT } from '../qa/check-core-inbox.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';

const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
const NOW = '2026-11-09T10:00:00.000Z';

const L = {
  ru: {
    titles: ['Вход на стенд', 'Выход со стенда'],
    step: 'в элемент data-testid «greeting» текст «Привет, demo»',
    goal: 'войти под demo и увидеть приветствие',
    environments: ['Локально', 'QA-стенд'],
    record: 'Записать сценарий',
    goalLabel: 'Что пройти на стенде',
    start: 'Начать проход',
    nameLabel: 'Название сценария',
  },
  en: {
    titles: ['Log in to the stand', 'Log out of the stand'],
    step: 'element data-testid "greeting" has text "Hello, demo"',
    goal: 'log in as demo and see the greeting',
    environments: ['Local', 'QA stand'],
    record: 'Record a scenario',
    goalLabel: 'What to walk on the stand',
    start: 'Start the walk',
    nameLabel: 'Scenario name',
  },
};

/**
 * Проект раздела на языке варианта: подмена проверки отдаёт окружения по-русски. Обработчик,
 * поставленный позже, отвечает первым — подмена проверки под ним не трогается.
 */
async function localizeProject(page, lang) {
  await page.unroute('**/api/project-tests?*', projectHandler).catch(() => undefined);
  projectHandler = (route) => {
    const [local, qa] = L[lang].environments;
    return route.fulfill({
      json: {
        projectPath: TESTS_PROJECT.path,
        dir: '.agent/tests',
        hasConvention: true,
        sharedSteps: [],
        environments: [
          { id: 'local', title: local, isDefault: true },
          { id: 'qa', title: qa },
        ],
        schema: { attributes: [], statuses: [] },
        views: [],
        plans: [],
        branch: 'main',
        groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: [] }],
      },
    });
  };
  await page.route('**/api/project-tests?*', projectHandler);
}
let projectHandler = () => undefined;

const step = (n, ok, kind = 'click') => ({
  stepId: `0190a000-0000-7000-8000-00000000000${n}`,
  kind,
  ok,
});

function cases(lang) {
  const marks = (count, failAt) =>
    Array.from({ length: count }, (_, i) => ({
      runId: `run-${i}`,
      startedAt: new Date(Date.parse(NOW) - i * 3_600_000).toISOString(),
      status: i === failAt ? 'failed' : 'passed',
    }));
  return L[lang].titles.map((title, i) => ({
    groupId: 'scenarios',
    caseId: `scenarios-00${i + 1}`,
    title,
    file: `.agent/tests/recorded/scenarios/scenarios-00${i + 1}.recorded.mjs`,
    testName: `recorded > ${title}`,
    taskId: `task-${i + 1}`,
    unchecked: i === 0 ? 2 : 0,
    status: 'passed',
    history: i === 0 ? marks(20, 7) : marks(6, -1),
  }));
}

function mismatch(lang, verdict) {
  const t = L[lang];
  return {
    status: 'mismatch',
    startedAt: NOW,
    finishedAt: NOW,
    environmentId: 'qa',
    total: 2,
    runId: 'run-qa-1',
    mismatch: {
      groupId: 'scenarios',
      caseId: 'scenarios-001',
      title: t.titles[0],
      step: { n: 5, title: t.step },
      message: `✗ ${lang === 'ru' ? 'шаг' : 'step'} 5: ${t.step}`,
      taskId: 'walk-mismatch',
      ...(verdict ? { verdict } : {}),
    },
  };
}

const stand = await startStand({ label: 'tests-recorded-help-shots' });

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

async function shotArea(scenario, page, frameId, selector, padding = 16) {
  const overlay = page.locator('vite-error-overlay');
  if (await overlay.count()) {
    const text = await overlay.evaluate((node) => node.shadowRoot?.textContent ?? '');
    throw new Error(`фронт стенда не собрался: ${text.slice(0, 600)}`);
  }
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 60_000 });
  await page.mouse.move(2, 2);
  await wait(600);
  await scenario.shot(page, frameId, { clip: selector, padding, maskText: MASKS });
}

async function shootVariant(page, state, variant) {
  const lang = variant.lang;
  const url = `${stand.webUrl}/tests?tab=recorded`;
  const scenario = openScenario('tests', 'recorded', lang, variant.theme);

  await localizeProject(page, lang);
  state.cases = cases(lang);
  state.replay = { status: 'passed', startedAt: NOW, finishedAt: NOW, total: 2 };
  await toVariant(page, variant, url);
  await page.locator('[data-testid="recorded-case"]').first().waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '01-list', '[data-tests-recorded]');

  state.nextWalk = `walk-${variant.key}`;
  state.walks[state.nextWalk] = [
    {
      steps: [step(1, true, 'open'), step(2, true, 'fill'), step(3, true), step(4, true, 'expect')],
      gaps: [{ at: step(3, true).stepId, reason: 'captcha' }],
      ended: true,
    },
  ];
  await page.getByRole('button', { name: L[lang].record, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(L[lang].goalLabel).fill(L[lang].goal);
  await dialog.getByRole('button', { name: L[lang].start, exact: true }).click();
  const name = dialog.getByLabel(L[lang].nameLabel);
  await name.waitFor({ timeout: 20_000 });
  await name.fill(L[lang].titles[0]);
  await name.blur();
  await shotArea(scenario, page, '02-record', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });

  state.replay = mismatch(lang);
  await toVariant(page, variant, url);
  await page.locator('[data-testid="recorded-mismatch"]').waitFor({ timeout: 60_000 });
  await shotArea(scenario, page, '03-mismatch', '[data-tests-recorded]');

  state.replay = mismatch(lang, 'stale');
  state.walks['walk-mismatch'] = [{ steps: [step(1, true, 'open'), step(2, true)], ended: true }];
  await toVariant(page, variant, url);
  const card = page.locator('[data-testid="recorded-mismatch"]');
  await card.waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="recorded-mismatch"] button')].some(
        (b) => !b.disabled,
      ),
    undefined,
    { timeout: 20_000 },
  );
  await shotArea(scenario, page, '04-rerecord', '[data-testid="recorded-mismatch"]');
  scenario.finish();
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const page = await stand.newPage(browser, { width: 1600, height: 1100 });
  await page.goto(stand.webUrl, { waitUntil: 'domcontentloaded' });
  const { state } = await installRecordedStub(page);
  for (const variant of SHOT_VARIANTS) {
    console.log(`\nвариант ${variant.key}`);
    await shootVariant(page, state, variant);
  }
  if (page.errors?.length) console.log(`ошибки страницы: ${page.errors.join(' | ')}`);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
