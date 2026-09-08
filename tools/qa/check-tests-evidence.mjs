/**
 * Доказательность провала.
 *
 * «Провалился» без номера шага и без снимка нельзя ни воспроизвести, ни завести
 * дефектом. Здесь проверяется, что панель об этом ГОВОРИТ — и при этом ничего не
 * выбрасывает: неполный результат виден на экране целиком, помеченный как
 * неполный, а не спрятан и не отвергнут.
 *
 * Два места, два повода:
 *  - запись прогона: у провала виден шаг, разбор, метка «нет доказательства» и
 *    итог второй попытки;
 *  - отчёт: карточка «Чем доказаны провалы» со счётом и кнопкой перепройти.
 *
 * Ответы сервера подменяются целиком: настоящая история живёт в проверяемом
 * проекте, и на чужой машине её нет.
 *
 * Запуск: `node tools/qa/check-tests-evidence.mjs` при поднятом `pnpm dev`.
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
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // 404 сравнения — не поломка, а подменённый ответ «сравнивать не с чем»:
  // браузер печатает его в консоль сам, а страница показывает эту причину.
  if ((message.location()?.url ?? '').includes('/run/diff')) return;
  problems.push(message.text());
});

const RESULTS = [
  {
    pointId: 'gui|gui-001|local',
    groupId: 'gui',
    caseId: 'gui-001',
    status: 'failed',
    note: 'кнопка осталась активной',
    attachments: ['.agent/tests/attachments/gui-001/shot.png'],
    failure: {
      step: 2,
      expected: 'кнопка выключена',
      actual: 'кнопка активна, форма отправилась',
      retry: 'confirmed',
    },
  },
  {
    pointId: 'gui|gui-002|local',
    groupId: 'gui',
    caseId: 'gui-002',
    status: 'failed',
    note: 'не открылось',
  },
  {
    pointId: 'gui|gui-003|local',
    groupId: 'gui',
    caseId: 'gui-003',
    status: 'blocked',
    note: 'первая попытка легла, вторая прошла',
    failure: { retry: 'flaky', retryNote: 'настройки открылись' },
  },
];

const RUN = {
  id: 'run-1',
  mode: 'run',
  actor: 'agent',
  status: 'done',
  environmentId: 'local',
  startedAt: '2026-09-08T10:00:00.000Z',
  finishedAt: '2026-09-08T10:20:00.000Z',
  results: RESULTS,
  summary: { total: 3, passed: 0, failed: 2, skipped: 0, blocked: 1 },
};

const REPORT = {
  runs: [RUN],
  areas: [{ area: 'чат', total: 3, passed: 0, failed: 3, unknown: 0 }],
  automation: { manual: 3, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  evidence: {
    failed: 3,
    proven: 1,
    detailed: 1,
    missing: [
      { groupId: 'gui', caseId: 'gui-002', title: 'Пустой ввод не отправляется' },
      { groupId: 'gui', caseId: 'gui-003', title: 'Открытие настроек' },
    ],
    flaky: [{ groupId: 'gui', caseId: 'gui-003', title: 'Открытие настроек' }],
  },
  releases: [],
  totals: {
    runs: 1,
    tokens: 0,
    costUsd: 0,
    durationMs: 1_200_000,
    lastRunAt: '2026-09-08T10:20:00.000Z',
    muted: 0,
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
          steps: [
            { action: 'открыть форму', expected: 'форма показана' },
            { action: 'отправить пустую', expected: 'кнопка выключена' },
          ],
          status: 'failed',
          source: 'agent',
        },
        {
          id: 'gui-002',
          type: 'case',
          title: 'Пустой ввод не отправляется',
          steps: [],
          status: 'failed',
          source: 'agent',
        },
        {
          id: 'gui-003',
          type: 'case',
          title: 'Открытие настроек',
          steps: [],
          status: 'blocked',
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
        lastActivity: '2026-09-08T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

/** Тела запусков: по ним проверяется, что кнопка гонит именно недоказанные. */
const started = [];

// Порядок важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему обработчику, а
// `**/run*` подходит и к `/runs`, и к `/run/diff`.
await page.route('**/api/project-tests/run*', async (route) => {
  const request = route.request();
  if (request.method() === 'POST') {
    started.push(JSON.parse(request.postData() ?? '{}'));
    return route.fulfill({ json: view });
  }
  return route.fulfill({ json: { run: RUN } });
});
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [RUN] } }),
);
// Сравнивать не с чем: в подмене один прогон, и сервер на такой запрос отвечает
// 404 — тот же ответ, что у первого прогона в живом проекте.
await page.route('**/api/project-tests/run/diff*', async (route) =>
  route.fulfill({ status: 404, json: { message: 'Сравнивать не с чем: это первый прогон.' } }),
);
await page.route('**/api/project-tests/report*', async (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/defects/refresh*', async (route) =>
  route.fulfill({ json: { checked: 0, closed: 0, recheck: [] } }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({ json: { checked: 3, findings: [], byRule: [], duplicates: [] } }),
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

/** Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-evidence.mjs`. */
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
  console.log('\nСтраница раздела не открылась — доказательность проверить не на чем.');
  await browser.close();
  process.exit(1);
}

const head = main.locator('[aria-expanded][aria-controls^="run-body-"]').first();
if ((await head.count()) === 0) {
  check(false, 'запись прогона раскрывается');
  await browser.close();
  process.exit(1);
}
await head.click();
await page.waitForTimeout(1500);

// Разбор провала на экране: шаг, ожидание и факт.
check((await main.getByText(/шаг 2/i).count()) > 0, 'у провала показан номер шага');
check(
  (await main.getByText(/ожидалось: кнопка выключена/i).count()) > 0,
  'видно, что должно было быть на этом шаге',
);
check(
  (await main.getByText(/вышло: кнопка активна/i).count()) > 0,
  'видно, что вышло на самом деле',
);
check(
  (await main.getByText(/провал подтверждён/i).count()) > 0,
  'подтверждённый второй попыткой провал назван так',
);

// Недоказанный провал помечен — и при этом остался на экране целиком.
check((await main.getByText(/нет доказательства/i).count()) > 0, 'недоказанный провал помечен');
check(
  (await main.getByText('не открылось').count()) > 0,
  'недоказанный результат никуда не делся: панель не выбрасывает работу прогона',
);
check(
  (await main.getByText(/вторая попытка разошлась/i).count()) > 0,
  'разошедшиеся попытки названы отдельно',
);
check(
  (await main.getByText(/со второго раза: настройки открылись/i).count()) > 0,
  'видно, что вышло со второго раза',
);
await shot('run-evidence');

// Отчёт: счёт и кнопка перепройти недоказанные.
await page.goto(`${BASE}/tests?tab=report`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
check(
  (await main.getByText(/Чем доказаны провалы/i).count()) > 0,
  'в отчёте есть карточка доказательности',
);
check(
  (await main.getByText(/с доказательством:\s*1/i).count()) > 0,
  'счёт доказанных провалов показан',
);
check(
  (await main.getByText(/Не доказаны ничем/i).count()) > 0,
  'недоказанные перечислены поимённо',
);
check(
  (await main.getByText('Пустой ввод не отправляется').count()) > 0,
  'недоказанный кейс назван по имени',
);

const recheck = main.getByRole('button', { name: /Перепройти недоказанные/i }).first();
const hasRecheck = (await recheck.count()) > 0;
check(hasRecheck, 'у списка недоказанных есть кнопка перепрогона');
if (hasRecheck) {
  await recheck.click();
  await page.waitForTimeout(1200);
  const startedRun = started.at(-1);
  check(startedRun?.mode === 'run', 'перепрогон стартует прогоном');
  check(
    JSON.stringify(startedRun?.caseIds ?? []) === JSON.stringify(['gui-002', 'gui-003']),
    `перепрогон ушёл ровно по недоказанным (${(startedRun?.caseIds ?? []).join(', ') || 'пусто'})`,
  );
}
await shot('report-evidence');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nДоказательность провалов в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
