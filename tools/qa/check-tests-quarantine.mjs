/**
 * Карантин с самоочисткой и устаревание кейсов.
 *
 * Проверяется главное свойство раздела: панель СЧИТАЕТ и предлагает, но не
 * применяет. Кейс, у которого пять зелёных подряд, приезжает предложением снять
 * карантин; нестабильный — предложением его поставить, и кнопка не нажимается,
 * пока причина пуста; разошедшееся с трекером требование стоит отдельной
 * строкой. Библиотека при этом не меняется сама ни от одного из них.
 *
 * Ответы сервера подменяются целиком: история прогонов и даты требований живут в
 * проверяемом проекте и в чужой Jira, и на другой машине их нет.
 *
 * Запуск: `node tools/qa/check-tests-quarantine.mjs` при поднятом `pnpm dev`.
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
  // Сравнивать не с чем: в подмене один прогон, и 404 сюда печатает браузер сам.
  if ((message.location()?.url ?? '').includes('/run/diff')) return;
  problems.push(message.text());
});

const QUARANTINE = {
  lift: [
    {
      kind: 'lift',
      groupId: 'gui',
      caseId: 'gui-001',
      title: 'Вход существующим пользователем',
      message: 'Зелёных подряд: 5 при пороге 5. Поломка больше не воспроизводится.',
      muteReason: 'ждём починки логина',
      stability: 100,
      runs: 6,
      greenStreak: 5,
    },
  ],
  quarantine: [
    {
      kind: 'quarantine',
      groupId: 'gui',
      caseId: 'gui-002',
      title: 'Пустой ввод не отправляется',
      message: 'Стабильность 20% на 5 результатах при пороге 70%.',
      reason: 'Нестабилен: стабильность 20% на 5 результатах.',
      stability: 20,
      runs: 5,
      greenStreak: 0,
    },
  ],
  stale: [
    {
      groupId: 'gui',
      caseId: 'gui-003',
      title: 'Открытие настроек',
      key: 'QA-42',
      url: 'https://jira.example/browse/QA-42',
      requirementUpdatedAt: '2026-09-01T00:00:00.000Z',
      caseUpdatedAt: '2026-08-01T00:00:00.000Z',
      days: 31,
    },
  ],
  thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
  checkedAt: '2026-09-08T10:00:00.000Z',
};

const RUN = {
  id: 'run-1',
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt: '2026-09-08T10:00:00.000Z',
  finishedAt: '2026-09-08T10:20:00.000Z',
  results: [
    { pointId: 'gui|gui-001', groupId: 'gui', caseId: 'gui-001', status: 'passed' },
    { pointId: 'gui|gui-002', groupId: 'gui', caseId: 'gui-002', status: 'failed' },
  ],
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, blocked: 0 },
};

const REPORT = {
  runs: [RUN],
  areas: [{ area: 'чат', total: 3, passed: 1, failed: 1, unknown: 1 }],
  automation: { manual: 3, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  evidence: { failed: 1, proven: 0, detailed: 0, missing: [], flaky: [] },
  releases: [],
  totals: {
    runs: 1,
    tokens: 0,
    costUsd: 0,
    durationMs: 1_200_000,
    lastRunAt: '2026-09-08T10:20:00.000Z',
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
  drafts: [],
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
          status: 'passed',
          muted: true,
          muteReason: 'ждём починки логина',
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
          status: 'unknown',
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

/** Тела массовых правок: по ним видно, что и с какой причиной ушло на сервер. */
const bulks = [];

await page.route('**/api/project-tests/bulk*', async (route) => {
  bulks.push(JSON.parse(route.request().postData() ?? '{}'));
  return route.fulfill({ json: { touched: 1, view } });
});
await page.route('**/api/project-tests/run/diff*', async (route) =>
  route.fulfill({ status: 404, json: { message: 'Сравнивать не с чем: это первый прогон.' } }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [RUN] } }),
);
await page.route('**/api/project-tests/report*', async (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/defects/refresh*', async (route) =>
  route.fulfill({ json: { checked: 0, closed: 0, recheck: [] } }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [
        {
          rule: 'not-run',
          severity: 'info',
          groupId: 'gui',
          caseId: 'gui-003',
          title: 'Открытие настроек',
          message: 'Не гонялся 120 дней: показанный статус давно ничего не доказывает.',
        },
      ],
      byRule: [{ rule: 'not-run', severity: 'info', title: 'Давно не гонялся', count: 1 }],
      duplicates: [],
      checked: 3,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
await page.route('**/api/project-tests/quarantine*', async (route) =>
  route.fulfill({ json: QUARANTINE }),
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

/** Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-quarantine.mjs`. */
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

await page.goto(`${BASE}/tests?tab=report`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2200);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — карантин проверить не на чем.');
  await browser.close();
  process.exit(1);
}

check(
  (await main.getByText(/Карантин и устаревание/i).count()) > 0,
  'в отчёте есть карточка карантина',
);
check(
  (await main.getByText(/5 зелёных подряд/i).count()) > 0,
  'пороги названы прямо на экране, а не спрятаны в коде',
);

// Снять карантин: предложение видно вместе с действующей причиной.
check((await main.getByText(/Пора вернуть в строй/i).count()) > 0, 'зелёная серия названа списком');
check(
  (await main.getByText('Вход существующим пользователем').count()) > 0,
  'кейс из карантина назван по имени',
);
check(
  (await main.getByText(/В карантине: ждём починки логина/i).count()) > 0,
  'видно, чего этот карантин ждал',
);

// Поставить карантин: причина подставлена, и без неё кнопка не работает.
check((await main.getByText(/Пора выключить/i).count()) > 0, 'нестабильный кейс назван списком');
const reason = main.getByLabel(/Причина карантина/i).first();
const hasReason = (await reason.count()) > 0;
check(hasReason, 'причина карантина вводится тут же');
check(
  hasReason && /Нестабилен/i.test(await reason.inputValue()),
  'причина подставлена числами, а не пустая',
);

const mute = main.getByRole('button', { name: /^Поставить карантин$/i }).first();
if (hasReason) {
  await reason.fill('');
  await page.waitForTimeout(400);
  check(await mute.isDisabled(), 'без причины карантин поставить нельзя');
  await reason.fill('ждём ответа бэкенда');
  await page.waitForTimeout(400);
  check(!(await mute.isDisabled()), 'с причиной кнопка оживает');
}

// Разошедшееся требование — отдельной строкой, со ссылкой на задачу.
check(
  (await main.getByText(/Разошлись с требованием/i).count()) > 0,
  'расхождение с требованием стоит отдельным списком',
);
check(
  (await main.getByText(/QA-42 правили на 31 дн\. позже кейса/i).count()) > 0,
  'сказано, на сколько требование новее кейса',
);
check(
  (await main.getByText(/Давно не гонялся/i).count()) > 0,
  '«давно не гонялся» — отдельная строка здоровья набора',
);
await shot('report-quarantine');

// Применяет — человек: до нажатия на сервер не ушло ни одной правки.
check(bulks.length === 0, 'ни одно предложение не применилось само');

await mute.click();
await page.waitForTimeout(1200);
const muted = bulks.at(-1);
check(muted?.action === 'mute', 'кнопка ставит карантин обычным массовым действием');
check(muted?.value === 'ждём ответа бэкенда', 'причина уехала на сервер вместе с действием');
check(
  JSON.stringify(muted?.caseIds ?? []) === JSON.stringify(['gui-002']),
  'карантин ушёл ровно по одному кейсу',
);

const lift = main.getByRole('button', { name: /^Снять карантин$/i }).first();
if ((await lift.count()) > 0) {
  await lift.click();
  await page.waitForTimeout(1200);
  const lifted = bulks.at(-1);
  check(lifted?.action === 'unmute', 'снятие карантина — то же массовое действие');
  check(
    JSON.stringify(lifted?.caseIds ?? []) === JSON.stringify(['gui-001']),
    'снятие ушло ровно по своему кейсу',
  );
} else {
  check(false, 'у предложения снять карантин есть кнопка');
}

// Переход на кейс: из отчёта в библиотеку, тем же адресом, что и у поиска.
await main.getByRole('button', { name: 'Открытие настроек' }).first().click();
await page.waitForTimeout(1500);
check(page.url().includes('id=gui%3Agui-003'), `со строки открывается сам кейс: ${page.url()}`);

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nКарантин и устаревание в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
