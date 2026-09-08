/**
 * Матрица покрытия, судьба дефектов, карантин и вехи — то, чего в разделе не
 * было до этой партии.
 *
 * Проверяется ровно то, ради чего эти виды существуют:
 *  - непокрытое требование стоит ПЕРВЫМ и подписано словом, а не пустой ячейкой;
 *  - кейсы без требования перечислены отдельно (дыра в прослеживаемости);
 *  - отключённый Atlassian не молчит, а объясняет, почему видно только связанное;
 *  - «Обновить статусы дефектов» приносит список «перепроверить»;
 *  - кейс в карантине помечен в списке и отбирается фильтром;
 *  - веха в отчёте показывает НЕПРОВЕРЕННОЕ — число, ради которого её и завели.
 *
 * Ответы сервера подменяются целиком: настоящая матрица требует привязанного
 * проекта и живой Jira, а проверка не имеет права зависеть ни от того, ни от
 * другого.
 *
 * Запуск: `node tools/qa/check-tests-coverage.mjs` при поднятом `pnpm dev`.
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

const counts = (passed = 0, failed = 0) => ({
  passed,
  failed,
  blocked: 0,
  skipped: 0,
  unknown: 0,
});

/** Порядок намеренно «неправильный»: сервер сортирует, страница не пересортировывает. */
const COVERAGE = {
  items: [
    {
      key: 'QA-100',
      url: 'https://example.atlassian.net/browse/QA-100',
      title: 'Оплата картой',
      status: 'In Progress',
      cases: [],
      counts: counts(),
    },
    {
      key: 'QA-101',
      url: 'https://example.atlassian.net/browse/QA-101',
      title: 'Вход по почте',
      cases: [
        {
          groupId: 'gui',
          caseId: 'gui-001',
          title: 'Вход существующим пользователем',
          status: 'failed',
          muted: true,
        },
      ],
      counts: counts(0, 1),
    },
  ],
  orphans: [{ groupId: 'gui', caseId: 'gui-009', title: 'Регрессия шапки', status: 'passed' }],
  source: 'jira',
  jql: 'project = QA AND statusCategory != Done',
  warning: 'Atlassian не подключён: показаны только требования из ссылок кейсов.',
};

const DEFECTS = {
  checked: 2,
  closed: 1,
  recheck: [
    {
      groupId: 'gui',
      caseId: 'gui-001',
      title: 'Вход существующим пользователем',
      url: 'https://example.atlassian.net/browse/QA-42',
      key: 'QA-42',
    },
  ],
  skipped: [],
};

const REPORT = {
  runs: [],
  areas: [],
  automation: { manual: 1, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  releases: [
    {
      release: 'v1.4',
      runs: 3,
      passed: 12,
      failed: 2,
      untested: 7,
      lastRunAt: '2026-09-01T10:24:00.000Z',
    },
  ],
  totals: {
    runs: 3,
    tokens: 0,
    costUsd: 0,
    durationMs: 0,
    lastRunAt: '2026-09-01T10:24:00.000Z',
    muted: 1,
  },
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
          steps: [{ action: 'открыть вход', expected: 'форма показана' }],
          status: 'failed',
          muted: true,
          muteReason: 'ждём починки входа',
          source: 'human',
        },
        {
          id: 'gui-009',
          type: 'case',
          title: 'Регрессия шапки',
          steps: [],
          status: 'passed',
          source: 'human',
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
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

let coverageRequested = false;
let sentJql = null;
await page.route('**/api/project-tests/coverage*', async (route) => {
  coverageRequested = true;
  sentJql = JSON.parse(route.request().postData() ?? '{}').jql ?? null;
  return route.fulfill({ json: COVERAGE });
});
let defectsRequested = false;
await page.route('**/api/project-tests/defects/refresh*', async (route) => {
  defectsRequested = true;
  return route.fulfill({ json: DEFECTS });
});
await page.route('**/api/project-tests/report*', async (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/run*', async (route) =>
  route.fulfill({ json: { run: null } }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
// Здоровье набора живёт на той же вкладке отчёта: без заглушки линтер отвечает
// 400 на несуществующий проект, и проверка «ошибок в консоли нет» краснеет не
// о том.
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

/**
 * Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-coverage.mjs`.
 * Данные подменены, поэтому снимок показывает разметку и слова, а не чужой
 * проект, — и его можно приложить куда угодно.
 */
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

await page.goto(`${BASE}/tests?tab=coverage`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2200);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — покрытие проверить не на чем.');
  await browser.close();
  process.exit(1);
}

check(coverageRequested, 'страница запросила матрицу у сервера');

// Непокрытое требование — первым и словом: цветной кружок без подписи читается
// как «что-то не так», а не как «этого не проверяет никто».
check((await main.getByText('не покрыто').count()) > 0, 'непокрытое требование подписано словом');
const firstKey = await main
  .getByText(/QA-1\d\d/)
  .first()
  .textContent();
check(firstKey?.includes('QA-100') === true, 'непокрытое требование стоит первым');
check((await main.getByText('Оплата картой').count()) > 0, 'заголовок требования показан');
check((await main.getByText('Вход по почте').count()) > 0, 'покрытое требование тоже в матрице');
check(
  (await main.getByText('Вход существующим пользователем').first().count()) > 0,
  'кейс требования назван по имени',
);

// Карантин виден прямо в матрице: красный кейс, который не красит прогон, —
// это другой факт, чем просто красный.
check((await main.getByText(/карантин/i).count()) > 0, 'кейс в карантине помечен в матрице');

// Сироты — отдельным списком: это дыра в прослеживаемости, а не в покрытии.
check(
  (await main.getByText(/Кейсы без требования/i).count()) > 0,
  'кейсы без требования перечислены отдельно',
);
check((await main.getByText('Регрессия шапки').count()) > 0, 'кейс-сирота назван по имени');

// Предупреждение сервера — на экране. Молчащая матрица без Jira выглядела бы
// как полная, а она половинная.
check(
  (await main.getByText(/Atlassian не подключён/i).count()) > 0,
  'причина неполной матрицы названа',
);
await shot('coverage-matrix');

// Свой запрос применяется кнопкой и УХОДИТ на сервер: поле, которое ничего не
// меняет, хуже отсутствующего.
const jqlField = main.getByLabel(/Запрос требований/i).first();
if ((await jqlField.count()) === 0) {
  check(false, 'поле запроса JQL есть');
} else {
  await jqlField.fill('project = PAY');
  await main.getByRole('button', { name: 'Показать' }).first().click();
  await page.waitForTimeout(1200);
  check(sentJql === 'project = PAY', `свой JQL ушёл на сервер (${sentJql ?? 'ничего'})`);
}

// Обратный ход от трекера.
const refresh = main.getByRole('button', { name: /Обновить статусы дефектов/i }).first();
if ((await refresh.count()) === 0) {
  check(false, 'кнопка обновления статусов дефектов есть');
} else {
  await refresh.click();
  await page.waitForTimeout(1500);
  check(defectsRequested, 'запрос статусов ушёл на сервер');
  check(
    (await main.getByText(/Дефект закрыт, а кейс всё ещё красный/i).count()) > 0,
    'список «перепроверить» объяснён словами',
  );
  check((await main.getByText('QA-42').count()) > 0, 'дефект назван ключом');
  await shot('defect-recheck');
}

// Карантин в библиотеке: отметка на строке и отбор.
await page.goto(`${BASE}/tests?tab=library`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
check((await main.getByText(/карантин/i).count()) > 0, 'кейс в карантине помечен в библиотеке');
// Перед отбором обе строки на экране: иначе «фильтр убрал лишнее» доказывалось
// бы пустым списком, который и без фильтра был пуст.
check(
  (await main.getByText('Регрессия шапки').count()) > 0,
  'до отбора в списке виден кейс без карантина',
);
await shot('library-quarantine');
const mutedFilter = main.getByLabel(/Карантин/i).first();
if ((await mutedFilter.count()) === 0) {
  check(false, 'в библиотеке есть отбор по карантину');
} else {
  await mutedFilter.selectOption({ label: 'только карантин' }).catch(() => {});
  await page.waitForTimeout(800);
  const rows = await main.getByText('Регрессия шапки').count();
  check(rows === 0, 'отбор «только карантин» убрал кейсы без карантина');
}

// Веха в отчёте: главное её число — непроверенное.
await page.goto(`${BASE}/tests?tab=report`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
check((await main.getByText('v1.4').count()) > 0, 'веха названа в отчёте');
check(
  (await main.getByText(/не проверено:\s*7/i).count()) > 0,
  'у вехи показано непроверенное — число, ради которого её завели',
);
check(
  (await main.getByText(/В карантине:\s*1/i).count()) > 0,
  'счётчик карантина показан в итогах',
);
await shot('report-releases');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nПокрытие, дефекты, карантин и вехи в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
