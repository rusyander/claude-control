/**
 * Готовность релиза одним документом.
 *
 * Проверяется то, ради чего документ и заводили: вердикт стоит первым, под ним
 * — что мешает (непроверенное и незакрытые дефекты), и только потом требования
 * с провалами. Печать при этом идёт СВОИМ маршрутом: общая выгрузка формата
 * `pdf` не знает и отвечает отказом, а сломанную ссылку видно только глазами.
 *
 * Ответы сервера подменяются целиком: документ считается по истории прогонов
 * проверяемого проекта и по требованиям из чужой Jira — на другой машине их нет.
 *
 * Запуск: `node tools/qa/check-tests-release.mjs` при поднятом `pnpm dev`.
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

const RUN = {
  id: 'run-1',
  mode: 'run',
  actor: 'agent',
  status: 'done',
  release: '1.4',
  branch: 'release/1.4',
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
  areas: [],
  automation: { manual: 3, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  evidence: { failed: 1, proven: 0, detailed: 0, missing: [], flaky: [] },
  releases: [
    { release: '1.4', runs: 1, passed: 1, failed: 1, untested: 1, lastRunAt: RUN.startedAt },
    {
      release: '1.3',
      runs: 4,
      passed: 12,
      failed: 0,
      untested: 0,
      lastRunAt: '2026-08-01T10:00:00.000Z',
    },
  ],
  totals: {
    runs: 1,
    tokens: 0,
    costUsd: 0,
    durationMs: 1_200_000,
    lastRunAt: '2026-09-08T10:20:00.000Z',
    muted: 0,
  },
};

/** Документ вехи: непроверенное, дефект и провал — по одному, чтобы их было видно. */
const documentOf = (release) => ({
  release,
  generatedAt: '2026-09-08T12:00:00.000Z',
  branch: 'release/1.4',
  verdict: {
    ready: false,
    text: `Веха «${release}»: отдавать рано. Провалов: 1. Не проверено кейсов: 1 из 3. Незакрытых дефектов: 1.`,
    blockers: ['Провалов: 1.', 'Не проверено кейсов: 1 из 3.', 'Незакрытых дефектов: 1.'],
  },
  totals: {
    cases: 3,
    passed: 1,
    failed: 1,
    blocked: 0,
    skipped: 0,
    untested: 1,
    muted: 0,
    runs: 1,
  },
  requirements: [
    {
      key: 'QA-42',
      title: 'Вход по паролю',
      url: 'https://jira.example/browse/QA-42',
      cases: 2,
      passed: 1,
      failed: 1,
      untested: 0,
      state: 'red',
    },
  ],
  red: [
    {
      groupId: 'gui',
      caseId: 'gui-002',
      title: 'Пустой ввод не отправляется',
      priority: 'blocker',
      status: 'failed',
      note: 'форма отправилась',
    },
  ],
  untested: [{ groupId: 'gui', caseId: 'gui-003', title: 'Открытие настроек', status: 'unknown' }],
  muted: [],
  defects: [
    {
      url: 'https://jira.example/browse/QA-77',
      title: 'Логин падает на пустом пароле',
      key: 'QA-77',
      state: 'open',
      groupId: 'gui',
      caseId: 'gui-002',
      caseTitle: 'Пустой ввод не отправляется',
    },
  ],
  runs: [
    {
      id: 'run-1',
      mode: 'run',
      actor: 'agent',
      startedAt: RUN.startedAt,
      branch: 'release/1.4',
      summary: RUN.summary,
    },
  ],
  warning: 'Atlassian не подключён: показаны только требования из ссылок кейсов.',
});

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

/** Какие вехи спросили у сервера: по ним видно, что выбор в списке работает. */
const asked = [];

await page.route('**/api/project-tests/release*', async (route) => {
  const url = new URL(route.request().url());
  // Печать сюда не приходит: у неё свой маршрут — если пришла, это и есть ошибка.
  if (url.pathname.endsWith('/release/pdf') || url.pathname.endsWith('/release/export')) {
    return route.fulfill({ status: 500, json: { message: 'не должно спрашиваться из кода' } });
  }
  const release = url.searchParams.get('release') ?? '';
  asked.push(release);
  return route.fulfill({
    json: {
      releases: ['1.4', '1.3'],
      document: release ? documentOf(release) : undefined,
    },
  });
});
await page.route('**/api/project-tests/run/diff*', async (route) =>
  route.fulfill({ status: 404, json: { message: 'Сравнивать не с чем: это первый прогон.' } }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [RUN] } }),
);
await page.route('**/api/project-tests/run?*', async (route) =>
  route.fulfill({ json: { run: RUN } }),
);
await page.route('**/api/project-tests/report*', async (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 3,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
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

/** Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-release.mjs`. */
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
await page.waitForTimeout(2400);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — готовность проверить не на чем.');
  await browser.close();
  process.exit(1);
}

check(
  (await main.getByText(/Готовность релиза/i).count()) > 0,
  'карточка готовности есть в отчёте',
);
check(asked[0] === '1.4', `свежая веха выбрана сама: спросили «${asked[0] ?? ''}»`);
check(
  (await main.getByText(/Отдавать рано/i).count()) > 0,
  'вердикт назван словами, а не только числами',
);
check(
  (await main.getByText(/Не проверено кейсов: 1 из 3/i).count()) > 0,
  'причина вердикта названа поимённо',
);

// Что мешает — выше доказательств: непроверенное и дефекты перед требованиями.
const order = await main.evaluate((root) => {
  const text = root.innerText;
  return {
    untested: text.indexOf('Не проверено:'),
    defects: text.indexOf('Незакрытые дефекты:'),
    requirements: text.indexOf('Требования:'),
  };
});
check(
  order.untested > 0 && order.defects > 0,
  'непроверенное и дефекты названы отдельными списками',
);
check(
  order.untested < order.requirements && order.defects < order.requirements,
  `что мешает — выше требований (${order.untested} · ${order.defects} · ${order.requirements})`,
);
check(
  (await main.getByText('Логин падает на пустом пароле').count()) > 0,
  'незакрытый дефект назван по имени',
);
check(
  (await main.getByText('Пустой ввод не отправляется').first().count()) > 0,
  'провал вехи назван по имени',
);
check((await main.getByText(/QA-42/).count()) > 0, 'требование вехи стоит в документе');
check(
  (await main.getByText(/Atlassian не подключён/i).count()) > 0,
  'оговорка о трекере видна, а не проглочена',
);
await shot('report-release');

// Печать — своим маршрутом: у общей выгрузки формата pdf нет вовсе.
const pdfHref = await main
  .getByRole('link', { name: /Документ PDF/i })
  .first()
  .getAttribute('href');
const mdHref = await main
  .getByRole('link', { name: /Документ MD/i })
  .first()
  .getAttribute('href');
check(
  (pdfHref ?? '').includes('/api/project-tests/release/pdf?'),
  `PDF документа идёт на маршрут печати: ${pdfHref}`,
);
check(!(pdfHref ?? '').includes('format=pdf'), 'формата pdf в общей выгрузке нет');
check(
  (mdHref ?? '').includes('/release/export?') && (mdHref ?? '').includes('release=1.4'),
  `MD документа несёт веху: ${mdHref}`,
);

// Другая веха — другой документ: выбор спрашивает сервер заново.
const picker = main.getByLabel(/^Веха$/i).first();
if ((await picker.count()) > 0) {
  await picker.selectOption('1.3');
  await page.waitForTimeout(1500);
  check(asked.includes('1.3'), `вторая веха спрошена у сервера: ${asked.join(', ')}`);
  check(
    (await main.getByText(/Веха «1\.3»/i).count()) > 0,
    'на экране документ выбранной вехи, а не прежней',
  );
} else {
  check(false, 'веха выбирается списком');
}

// Переход на кейс: из документа в библиотеку, тем же адресом, что и у поиска.
await main.getByRole('button', { name: 'Открытие настроек' }).first().click();
await page.waitForTimeout(1500);
check(page.url().includes('id=gui%3Agui-003'), `со строки открывается сам кейс: ${page.url()}`);

// Тот же маршрут печати у отчёта по прогону — ссылка ведёт к файлу, а не к 400.
await page.goto(`${BASE}/tests?tab=runs`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const runPdf = await page
  .getByRole('link', { name: /Отчёт \.pdf/i })
  .first()
  .getAttribute('href');
check(
  (runPdf ?? '').includes('/api/project-tests/run/pdf?'),
  `PDF прогона идёт на маршрут печати: ${runPdf}`,
);

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nДокумент готовности в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
