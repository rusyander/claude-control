/**
 * Прогон отчёта раздела «Тесты».
 *
 * Отчёт — единственное место, где видно не «что сейчас красное», а как набор
 * ведёт себя во времени: тренд прогонов, покрытие по зонам, нестабильные кейсы,
 * потраченное время и токены. Всё это считается по записям в `runs/`, поэтому
 * проверяется одно: приходит ли КАЖДЫЙ кусок ответа на экран. Виджет, который
 * молча не нарисовался, — это не пустой отчёт, а потерянные данные.
 *
 * Отдельно проверяется, что прогон из CI подписан как чужой: импортированный
 * результат, выглядящий как собственный прогон панели, обесценивает и то, и
 * другое.
 *
 * Ответ сервера подменяется целиком: настоящая история живёт в проверяемом
 * проекте, и на чужой машине её нет.
 *
 * Запуск: `node tools/qa/check-tests-report.mjs` при поднятом `pnpm dev`.
 */
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

const summary = (passed, failed, skipped, blocked) => ({
  total: passed + failed + skipped + blocked,
  passed,
  failed,
  skipped,
  blocked,
});

const RUNS = [
  {
    id: 'run-3',
    mode: 'manual',
    actor: 'human',
    groupId: 'gui',
    environmentId: 'local',
    branch: 'qa/branch',
    commit: 'abcdef1234567890',
    status: 'done',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:24:00.000Z',
    results: [],
    summary: summary(7, 2, 1, 1),
  },
  {
    id: 'run-2',
    mode: 'import',
    actor: 'ci',
    branch: 'main',
    status: 'done',
    startedAt: '2026-08-31T22:10:00.000Z',
    finishedAt: '2026-08-31T22:12:00.000Z',
    results: [],
    summary: summary(41, 3, 0, 0),
  },
  {
    id: 'run-1',
    mode: 'run',
    actor: 'agent',
    groupId: 'gui',
    branch: 'qa/branch',
    status: 'error',
    startedAt: '2026-08-30T09:00:00.000Z',
    finishedAt: '2026-08-30T09:07:00.000Z',
    error: 'приложение не поднялось',
    tokens: 128000,
    costUsd: 1.234,
    sessionId: 'session-1',
    results: [],
    summary: summary(3, 1, 0, 0),
  },
];

const REPORT = {
  runs: RUNS,
  areas: [
    { area: 'чат', total: 12, passed: 9, failed: 2, unknown: 1 },
    { area: 'аналитика', total: 5, passed: 5, failed: 0, unknown: 0 },
  ],
  automation: { manual: 11, toAutomate: 4, automated: 2 },
  flaky: [
    {
      caseId: 'gui-002',
      groupId: 'gui',
      title: 'Пустой ввод не отправляется',
      stability: 40,
      runs: 6,
      flips: 3,
    },
  ],
  failures: [
    {
      reason: 'страница не открылась',
      count: 4,
      cases: [
        { groupId: 'gui', caseId: 'gui-002', title: 'Пустой ввод не отправляется' },
        { groupId: 'gui', caseId: 'gui-003', title: 'Отправка сообщения' },
      ],
      lastSeenAt: '2026-09-01T10:20:00.000Z',
    },
  ],
  totals: {
    runs: 3,
    tokens: 128000,
    costUsd: 1.234,
    durationMs: 1_980_000,
    lastRunAt: '2026-09-01T10:24:00.000Z',
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
  branch: 'qa/branch',
  commit: 'abcdef1234567890',
  groups: [
    {
      id: 'gui',
      title: 'GUI',
      file: '.agent/tests/gui.tests.json',
      cases: [
        {
          id: 'gui-002',
          type: 'case',
          title: 'Пустой ввод не отправляется',
          steps: [{ action: 'очистить поле', expected: 'поле пустое' }],
          expected: 'кнопка выключена',
          priority: 'blocker',
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
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

let reportRequested = false;
await page.route('**/api/project-tests/report*', async (route) => {
  reportRequested = true;
  return route.fulfill({ json: REPORT });
});
/**
 * Порядок регистрации важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
 * обработчику, а `**\/run*` подходит и к `/runs`. Разбор одной записи идёт
 * первым, список — после него.
 */
await page.route('**/api/project-tests/run*', async (route) => {
  const id = new URL(route.request().url()).searchParams.get('id');
  const record = RUNS.find((item) => item.id === id);
  return route.fulfill({
    json: {
      run: record && {
        ...record,
        results: [
          {
            pointId: 'gui|gui-002|local',
            groupId: 'gui',
            caseId: 'gui-002',
            status: 'failed',
            note: 'кнопка осталась активной',
          },
        ],
      },
    },
  });
});
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: RUNS } }),
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
  console.log('\nСтраница раздела не открылась — отчёт проверить не на чем.');
  await browser.close();
  process.exit(1);
}

const main = page.getByRole('main').or(page.locator('body')).first();

// Вкладка отчёта. Имя ищем и как таб, и как кнопку: разметка вкладок раздела
// не проверяется здесь — проверяется, что отчёт достижим и рисуется.
const tab = main
  .getByRole('tab', { name: /Отчёт|Отчет/ })
  .first()
  .or(main.getByRole('button', { name: /Отчёт|Отчет/ }).first());
if ((await tab.count()) === 0) {
  check(false, 'у раздела есть вкладка «Отчёт»');
  console.log('\nВкладка отчёта не найдена — виджеты проверить не на чем.');
  await browser.close();
  process.exit(1);
}
await tab.first().click();
await page.waitForTimeout(1800);

check(reportRequested, 'страница запросила отчёт у сервера');

// Итоги: сколько прогонов, когда последний, сколько потрачено.
check((await main.getByText(/\b3\b/).count()) > 0, 'число прогонов показано');
check(
  (await main.getByText(/128\s*000|128k|128\.0k|1\.2k|128 000/i).count()) > 0,
  'расход токенов показан',
);

// Покрытие по зонам: и название зоны, и её счёт.
check((await main.getByText('чат', { exact: false }).count()) > 0, 'зона «чат» в отчёте есть');
check(
  (await main.getByText('аналитика', { exact: false }).count()) > 0,
  'зона «аналитика» в отчёте есть',
);
check((await main.getByText(/\b12\b/).count()) > 0, 'счёт кейсов по зоне показан');

// Покрытие автоматизацией — три числа, а не одно.
check((await main.getByText(/\b11\b/).count()) > 0, 'кейсы, проверяемые руками, посчитаны');
check((await main.getByText(/\b4\b/).count()) > 0, 'кейсы в очереди на автоматизацию посчитаны');
check((await main.getByText(/\b2\b/).count()) > 0, 'автоматизированные кейсы посчитаны');

// Нестабильные: без названия кейса список бесполезен.
check(
  (await main.getByText('Пустой ввод не отправляется').count()) > 0,
  'нестабильный кейс назван по имени',
);
check((await main.getByText(/40\s*%/).count()) > 0, 'стабильность кейса показана числом');

// Одинаковые падения: отчёт обязан отвечать на «что сломалось», а не только на
// «сколько красного» — одна поломка красит сразу несколько кейсов.
check(
  (await main.getByText('страница не открылась').count()) > 0,
  'причина падения названа словами',
);
check((await main.getByText(/кейсов:\s*2/).count()) > 0, 'у причины перечислены задетые кейсы');

// Тренд рисуется по тем же прогонам: без него отчёт отвечает только на «что
// сейчас», а он существует ради «как это менялось».
check(
  (await main.locator('svg, [class*="trend"], [class*="Trend"]').count()) > 0,
  'тренд по прогонам нарисован',
);

// История прогонов — соседняя вкладка того же раздела. Проверяется здесь же:
// отчёт и история читают одни и те же записи, и разойтись они не должны.
const runsTab = main
  .getByRole('tab', { name: /Прогоны|История/ })
  .first()
  .or(main.getByRole('button', { name: /Прогоны|История прогонов/ }).first());
if ((await runsTab.count()) === 0) {
  check(false, 'у раздела есть вкладка истории прогонов');
} else {
  await runsTab.first().click();
  await page.waitForTimeout(1500);
  check((await main.getByText(/CI|импорт/i).count()) > 0, 'прогон из CI подписан как чужой');
  check((await main.getByText(/ручн/i).count()) > 0, 'ручной прогон подписан');
  check(
    (await main.getByText('приложение не поднялось').count()) > 0,
    'сорвавшийся прогон объясняет причину',
  );
  check((await main.getByText(/qa\/branch/).count()) > 0, 'ветка прогона показана');

  // Раскрытая запись объясняет, ПОЧЕМУ кейс красный: без заметки история
  // остаётся счётчиком.
  //
  // Заголовок ищем по aria-controls, а не по первому попавшемуся
  // `[aria-expanded]`: свернуть боковую панель — тоже раскрывающаяся кнопка, и
  // она стоит в разметке раньше.
  const head = main.locator('[aria-expanded][aria-controls^="run-body-"]').first();
  if ((await head.count()) > 0) {
    await head.click();
    await page.waitForTimeout(1200);
    check(
      (await main.getByText('кнопка осталась активной').count()) > 0,
      'в раскрытом прогоне видно, что увидели на самом деле',
    );
  } else {
    check(false, 'запись прогона раскрывается');
  }
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nОтчёт по тестам в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
