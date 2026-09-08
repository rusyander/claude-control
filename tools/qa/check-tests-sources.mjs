/**
 * Источники генерации: требование, дифф, провал.
 *
 * «Сгенерировать кейсы» отвечает на «что тут вообще есть». В работе спрашивают
 * другое, и разница между этими заданиями не в режиме прогона, а в том, ЧТО
 * агенту дали прочитать. Поэтому здесь проверяется не экран, а форма запроса:
 * каждая из трёх кнопок обязана унести на сервер свой `source` и то, из чего
 * материал собирать, — ключ требования, диапазон сравнения, кейс провала.
 *
 * Отдельно проверяется место кнопки. «Покрыть кейсами» стоит на строке
 * матрицы, а не в пульте: только там видно, какое требование не покрыто ничем.
 * «Регрессионный кейс» — у провала в записи прогона, где лежат заметка и
 * снимки. Кнопка, переехавшая в общий пульт, теряет вместе с местом и смысл:
 * человеку пришлось бы пересказывать в пожелании то, что панель уже знает.
 *
 * Сервер подменён целиком: настоящие источники требуют Jira, git-ветки и
 * истории прогонов проверяемого проекта — ничего этого на чужой машине нет.
 *
 * Запуск: `node tools/qa/check-tests-sources.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };
const RUN_ID = 'run-0007';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

const CASE = {
  id: 'gui-001',
  type: 'case',
  title: 'Отправка сообщения',
  steps: [{ action: 'нажать «Отправить»', expected: 'сообщение в ленте' }],
  oracle: 'сообщение видно в ленте',
  status: 'failed',
  source: 'agent',
};

const view = () => ({
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  drafts: [],
  autoAcceptDrafts: false,
  branch: 'qa/branch',
  commit: 'abcdef1234567890',
  groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: [{ ...CASE }] }],
});

/** Запись прогона с провалом — из неё и заводят регрессионный кейс. */
const RECORD = {
  id: RUN_ID,
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt: '2026-09-08T10:00:00.000Z',
  finishedAt: '2026-09-08T10:05:00.000Z',
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
  results: [],
};

const FULL_RUN = {
  ...RECORD,
  results: [
    {
      pointId: 'gui:gui-001',
      groupId: 'gui',
      caseId: 'gui-001',
      status: 'failed',
      note: 'сообщение пропало после перезагрузки',
      attachments: [],
    },
  ],
};

/** Требование без единого кейса — строка, ради которой матрицу и открывают. */
const COVERAGE = {
  source: 'jira',
  jql: 'project = QA',
  items: [
    {
      key: 'QA-42',
      url: 'https://acme.atlassian.net/browse/QA-42',
      title: 'Вход по одноразовой ссылке',
      status: 'В работе',
      cases: [],
      counts: { passed: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
    },
  ],
  orphans: [],
};

/** Что ушло на сервер: форма запроса и есть предмет этого сквозняка. */
let runBody;

await page.route('**/api/project-git*', async (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);

await page.route('**/api/chats/projects*', async (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

/**
 * Порядок регистрации важен: подходящий обработчик Playwright берёт ПОСЛЕДНИЙ,
 * а `run*` подходит и к `/runs`. Поэтому запуск идёт первым, а всё, что
 * длиннее, — после него.
 */
await page.route('**/api/project-tests/run*', async (route) => {
  if (route.request().method() === 'POST') {
    runBody = route.request().postDataJSON();
    return route.fulfill({ json: view() });
  }
  return route.fulfill({ json: { run: FULL_RUN } });
});

await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [RECORD] } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests/drafts*', async (route) =>
  route.fulfill({ json: { drafts: [], autoAccept: false } }),
);
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: COVERAGE }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 1,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
// Документ готовности вехи: карточка отчёта спрашивает его, как только у вехи
// есть имя. Без подмены это 400 в консоли, а не пропавшая карточка.
await page.route('**/api/project-tests/release*', async (route) =>
  route.fulfill({ json: { releases: [] } }),
);
await page.route('**/api/project-tests/quarantine*', async (route) =>
  route.fulfill({
    json: {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
await page.route('**/api/project-tests/risk*', async (route) =>
  route.fulfill({ json: { items: [], checkedAt: '2026-09-08T10:00:00.000Z' } }),
);
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view() }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (project) =>
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    ),
  PROJECT,
);

await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);

const opened = (await page.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — источники проверить не на чем.');
  await browser.close();
  process.exit(1);
}

const main = page.getByRole('main').or(page.locator('body')).first();

// 1. Дифф — кнопка в пульте рядом с обычной генерацией.
const byDiff = main.getByRole('button', { name: /^По диффу$/ }).first();
if ((await byDiff.count()) === 0) {
  check(false, 'в пульте есть запуск «По диффу»');
} else {
  runBody = undefined;
  await byDiff.click();
  await page.waitForTimeout(1200);
  check(runBody?.mode === 'generate', 'дифф — это источник генерации, а не отдельный режим');
  check(runBody?.source === 'diff', 'на сервер ушёл источник «дифф»');
  // Диапазон панель не выдумывает: пусто значит «сервер знает по умолчанию».
  check(runBody?.diffRange === undefined, 'диапазон сравнения оставлен серверу');
}

// 2. Требование — на строке матрицы покрытия, а не в пульте.
await main.getByRole('button', { name: /^Покрытие$/ }).click();
await page.waitForTimeout(1500);

check(
  (await main.getByText(/не покрыто/i).count()) > 0,
  'матрица показывает требование, к которому не привязан ни один кейс',
);
const cover = main.getByRole('button', { name: /^Покрыть кейсами$/ }).first();
if ((await cover.count()) === 0) {
  check(false, 'на строке требования есть «Покрыть кейсами»');
} else {
  runBody = undefined;
  await cover.click();
  await page.waitForTimeout(1200);
  check(runBody?.source === 'requirement', 'на сервер ушёл источник «требование»');
  check(
    runBody?.sourceRef === 'https://acme.atlassian.net/browse/QA-42',
    'вместе с запуском уехала сама задача, а не просто «покрыть что-нибудь»',
  );
  check(runBody?.path === PROJECT.path, 'запуск адресован открытому проекту');
}

// 3. Провал — у результата в записи прогона, где лежат заметка и снимки.
await main.getByRole('button', { name: /^Прогоны$/ }).click();
await page.waitForTimeout(1500);

const record = main.getByRole('button', { expanded: false }).first();
if ((await record.count()) === 0) {
  check(false, 'запись прогона раскрывается');
} else {
  await record.click();
  await page.waitForTimeout(1200);
}

check(
  (await main.getByText(/сообщение пропало после перезагрузки/).count()) > 0,
  'заметка провала видна — из неё и собираются шаги воспроизведения',
);
const regression = main.getByRole('button', { name: /^Регрессионный кейс$/ }).first();
if ((await regression.count()) === 0) {
  check(false, 'у провала есть «Регрессионный кейс»');
} else {
  runBody = undefined;
  await regression.click();
  await page.waitForTimeout(1200);
  check(runBody?.source === 'defect', 'на сервер ушёл источник «дефект»');
  check(
    runBody?.sourceCase?.caseId === 'gui-001' && runBody?.sourceCase?.runId === RUN_ID,
    'названы и кейс, и прогон: провал берётся конкретный, а не «последний красный»',
  );
  check(runBody?.groupId === 'gui', 'регрессионный кейс заводится в группе исходного');
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nИсточники генерации в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
