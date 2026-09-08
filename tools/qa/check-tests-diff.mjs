/**
 * Сравнение прогонов и перепрогон провалов.
 *
 * Главный вопрос после регресса — «что сломалось с прошлого раза». Раньше на
 * него отвечали глазами: две записи истории открывались по отдельности. Здесь
 * проверяется, что ответ приходит на экран разложенным по спискам И что кнопки
 * рядом с ним запускают прогон РОВНО по названным кейсам — иначе человек всё
 * равно идёт в пульт и отмечает те же кейсы руками.
 *
 * Три места, три повода:
 *  - запись прогона: «сравнить с предыдущим» и «перепрогнать провалившиеся»;
 *  - отчёт: блок «с прошлого прогона» без единого клика;
 *  - покрытие: «перепроверить» по кейсам, дефекты которых уже закрыты.
 *
 * Ответы сервера подменяются целиком: настоящая история живёт в проверяемом
 * проекте, и на чужой машине её нет.
 *
 * Запуск: `node tools/qa/check-tests-diff.mjs` при поднятом `pnpm dev`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

const summary = (passed, failed) => ({
  total: passed + failed,
  passed,
  failed,
  skipped: 0,
  blocked: 0,
});
const point = (caseId, status, note) => ({
  pointId: `gui|${caseId}|local`,
  groupId: 'gui',
  caseId,
  status,
  ...(note ? { note } : {}),
});

/** Новый прогон: два кейса красные — ровно они и должны уйти в перепрогон. */
const RESULTS = [
  point('gui-001', 'failed', 'кнопка не нажимается'),
  point('gui-002', 'passed'),
  point('gui-003', 'failed'),
  point('gui-004', 'passed'),
  point('gui-005', 'passed'),
];
const RED = ['gui-001', 'gui-003'];

const RUNS = [
  {
    id: 'run-2',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    planId: 'release',
    environmentId: 'stage',
    startedAt: '2026-09-07T10:00:00.000Z',
    finishedAt: '2026-09-07T10:20:00.000Z',
    results: RESULTS,
    summary: summary(3, 2),
  },
  {
    id: 'run-1',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    planId: 'smoke',
    environmentId: 'local',
    startedAt: '2026-09-06T10:00:00.000Z',
    finishedAt: '2026-09-06T10:18:00.000Z',
    results: [point('gui-001', 'passed'), point('gui-002', 'failed')],
    summary: summary(1, 1),
  },
];

const side = (record) => ({
  id: record.id,
  startedAt: record.startedAt,
  mode: record.mode,
  planId: record.planId,
  environmentId: record.environmentId,
  summary: record.summary,
});

const one = (caseId, title, from, to, note) => ({ groupId: 'gui', caseId, title, from, to, note });

const DIFF = {
  from: side(RUNS[1]),
  to: side(RUNS[0]),
  newFailures: [
    one('gui-001', 'Вход существующим пользователем', 'passed', 'failed', 'кнопка не нажимается'),
  ],
  fixed: [one('gui-002', 'Пустой ввод не отправляется', 'failed', 'passed')],
  stillFailing: [one('gui-003', 'Отправка сообщения', 'failed', 'failed')],
  untouched: [one('gui-004', 'Открытие настроек', 'passed', 'passed')],
  added: [one('gui-005', 'Экспорт отчёта', undefined, 'passed')],
  removed: [one('gui-006', 'Смена языка', 'passed', undefined)],
  comparable: false,
  warning: 'прогоны шли по разным планам, окружения разные — наборы кейсов не совпадают.',
};

const REPORT = {
  runs: RUNS,
  areas: [{ area: 'чат', total: 5, passed: 3, failed: 2, unknown: 0 }],
  automation: { manual: 5, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  releases: [],
  totals: {
    runs: 2,
    tokens: 0,
    costUsd: 0,
    durationMs: 0,
    lastRunAt: '2026-09-07T10:20:00.000Z',
    muted: 0,
  },
};

const DEFECTS = {
  checked: 3,
  closed: 2,
  recheck: [
    {
      groupId: 'gui',
      caseId: 'gui-001',
      title: 'Вход существующим пользователем',
      url: 'https://example.atlassian.net/browse/QA-42',
      key: 'QA-42',
    },
    {
      groupId: 'gui',
      caseId: 'gui-003',
      title: 'Отправка сообщения',
      url: 'https://example.atlassian.net/browse/QA-43',
      key: 'QA-43',
    },
  ],
  skipped: [],
};

const view = {
  projectPath: PROJECT.path,
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
      cases: [
        {
          id: 'gui-001',
          type: 'case',
          title: 'Вход существующим пользователем',
          steps: [],
          status: 'failed',
          source: 'agent',
        },
        {
          id: 'gui-003',
          type: 'case',
          title: 'Отправка сообщения',
          steps: [],
          status: 'failed',
          source: 'agent',
        },
      ],
    },
  ],
};

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
        lastActivity: '2026-09-07T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

/** Тела запусков: ради них весь прогон и написан. */
const started = [];

/**
 * Порядок регистрации важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
 * обработчику, а `**\/run*` подходит и к `/runs`, и к `/run/diff`. Поэтому
 * сначала общий, потом список, и сравнение — последним.
 */
await page.route('**/api/project-tests/run*', async (route) => {
  const request = route.request();
  if (request.method() === 'POST') {
    started.push(JSON.parse(request.postData() ?? '{}'));
    return route.fulfill({ json: view });
  }
  const id = new URL(request.url()).searchParams.get('id');
  return route.fulfill({ json: { run: RUNS.find((item) => item.id === id) ?? null } });
});
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: RUNS } }),
);
let diffRequested = null;
await page.route('**/api/project-tests/run/diff*', async (route) => {
  diffRequested = new URL(route.request().url()).searchParams.get('id');
  return route.fulfill({ json: DIFF });
});

await page.route('**/api/project-tests/report*', async (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/defects/refresh*', async (route) =>
  route.fulfill({ json: DEFECTS }),
);
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({ json: { checked: 2, findings: [], byRule: [], duplicates: [] } }),
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
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

/** Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-diff.mjs`. */
const shotsDir = process.env.SHOTS;
const shot = async (name) => {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
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

await page.goto(`${BASE}/tests?tab=runs`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2200);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — сравнивать нечего.');
  await browser.close();
  process.exit(1);
}

// Свёрнутая запись сравнения не запрашивает: считать дифф на каждый показ
// истории — платить за ответ, которого никто не спрашивал.
check(diffRequested === null, 'пока запись не раскрыта, сравнение не запрашивается');

const head = main.locator('[aria-expanded][aria-controls^="run-body-"]').first();
if ((await head.count()) === 0) {
  check(false, 'запись прогона раскрывается');
  await browser.close();
  process.exit(1);
}
await head.click();
await page.waitForTimeout(1200);

// Перепрогон провалов работает и без сравнения: первому прогону сравнивать
// себя не с чем, а красное у него уже есть.
const rerun = main.getByRole('button', { name: /Перепрогнать провалившиеся/i }).first();
check((await rerun.count()) > 0, 'у раскрытой записи есть «перепрогнать провалившиеся»');
check(
  (await main.getByText(/Перепрогнать провалившиеся \(2\)/i).count()) > 0,
  'в кнопке названо число красных кейсов',
);

await rerun.click();
await page.waitForTimeout(1200);
const startedRun = started.at(-1);
check(startedRun?.mode === 'run', 'перепрогон стартует прогоном, а не генерацией');
check(
  JSON.stringify(startedRun?.caseIds ?? []) === JSON.stringify(RED),
  `перепрогон ушёл ровно по красным кейсам (${(startedRun?.caseIds ?? []).join(', ') || 'пусто'})`,
);

// Сравнение — по кнопке.
const compare = main.getByRole('button', { name: /Сравнить с предыдущим/i }).first();
check((await compare.count()) > 0, 'у записи есть «сравнить с предыдущим»');
await compare.click();
await page.waitForTimeout(1500);
check(diffRequested === 'run-2', `сравнение запрошено для раскрытого прогона (${diffRequested})`);

check((await main.getByText(/Сломалось/i).count()) > 0, 'новые провалы названы отдельным списком');
check((await main.getByText(/Починилось/i).count()) > 0, 'починенные названы отдельным списком');
check(
  (await main.getByText(/Красное не первый раз/i).count()) > 0,
  'давние провалы отделены от новых',
);
check((await main.getByText(/Появилось в наборе/i).count()) > 0, 'новые кейсы названы');
check((await main.getByText(/Пропало из набора/i).count()) > 0, 'исчезнувшие кейсы названы');
check(
  (await main.getByText('Вход существующим пользователем').count()) > 0,
  'сломавшийся кейс назван по имени, а не по коду',
);
check(
  (await main.getByText('кнопка не нажимается').count()) > 0,
  'у нового провала видно, что увидели',
);
// Честность сравнения: другой план и другое окружение — другой набор.
check(
  (await main.getByText(/наборы кейсов не совпадают/i).count()) > 0,
  'разные планы и окружения названы прямо',
);
await shot('run-diff');

// Отчёт: тот же блок, но без единого клика — это первое, что там спрашивают.
diffRequested = null;
await page.goto(`${BASE}/tests?tab=report`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
check((await main.getByText(/С прошлого прогона/i).count()) > 0, 'в отчёте есть блок сравнения');
check(diffRequested === 'run-2', 'отчёт сравнивает последний прогон с результатами');
check(
  (await main.getByText('Вход существующим пользователем').count()) > 0,
  'в отчёте видно, что именно сломалось',
);
check(
  (await main.getByRole('button', { name: /Перепрогнать провалившиеся/i }).count()) > 0,
  'из отчёта тоже можно перепрогнать провалы',
);
await shot('report-diff');

// Покрытие: список «перепроверить» без кнопки заканчивался походом в пульт.
await page.goto(`${BASE}/tests?tab=coverage`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const refresh = main.getByRole('button', { name: /Обновить статусы дефектов/i }).first();
if ((await refresh.count()) === 0) {
  check(false, 'кнопка обновления статусов дефектов есть');
} else {
  await refresh.click();
  await page.waitForTimeout(1500);
  const recheck = main.getByRole('button', { name: /Перепроверить/i }).first();
  check((await recheck.count()) > 0, 'у списка «перепроверить» есть кнопка запуска');
  await recheck.click();
  await page.waitForTimeout(1200);
  const startedRecheck = started.at(-1);
  check(
    JSON.stringify(startedRecheck?.caseIds ?? []) === JSON.stringify(['gui-001', 'gui-003']),
    `перепроверка ушла по кейсам закрытых дефектов (${(startedRecheck?.caseIds ?? []).join(', ') || 'пусто'})`,
  );
  await shot('recheck-defects');
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nСравнение прогонов и перепрогон в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
