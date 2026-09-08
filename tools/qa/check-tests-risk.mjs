/**
 * Риск и время: порядок «по риску» и «у меня N минут».
 *
 * Проверяется то, чего не видно ни в одном юните: порядок строк НА ЭКРАНЕ
 * меняется от выбора порядка, счёт риска объясняется словами, а бюджет отмечает
 * кейсы и вслух называет невлезшее — не запуская при этом ни одного прогона.
 *
 * Ответы сервера подменяются целиком: риск считается по истории прогонов
 * проверяемого проекта, и на другой машине её нет.
 *
 * Запуск: `node tools/qa/check-tests-risk.mjs` при поднятом `pnpm dev`.
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
  problems.push(message.text());
});

/**
 * Библиотека нарочно лежит в порядке «сначала безопасное»: файл называет первым
 * зелёный кейс, а риск — красный. Иначе проверить порядок было бы нечем.
 */
const CASES = [
  {
    id: 'gui-001',
    type: 'case',
    title: 'Зелёный час назад',
    steps: [],
    status: 'passed',
    priority: 'blocker',
    duration: 20,
    source: 'agent',
  },
  {
    id: 'gui-002',
    type: 'case',
    title: 'Красный со вчера',
    steps: [],
    status: 'failed',
    priority: 'high',
    duration: 7,
    source: 'agent',
  },
  {
    id: 'gui-003',
    type: 'case',
    title: 'Ни разу не гонялся',
    steps: [],
    status: 'unknown',
    priority: 'medium',
    duration: 4,
    source: 'agent',
  },
];

const RISK = {
  items: [
    {
      groupId: 'gui',
      caseId: 'gui-002',
      key: 'gui:gui-002',
      title: 'Красный со вчера',
      score: 71,
      factors: [
        { key: 'priority', value: 0.8, note: 'важность high' },
        { key: 'outcome', value: 1, note: 'последний прогон красный' },
        { key: 'instability', value: 0.8, note: 'стабильность 60% на 5' },
        { key: 'age', value: 0.52, note: 'не гоняли 1 дн.' },
        { key: 'impact', value: 1, note: 'задет правками: изменён src/login.tsx' },
      ],
      reason: 'последний прогон красный; задет правками: изменён src/login.tsx',
      duration: 7,
      hasDuration: true,
      priority: 'high',
      status: 'failed',
    },
    {
      groupId: 'gui',
      caseId: 'gui-003',
      key: 'gui:gui-003',
      title: 'Ни разу не гонялся',
      score: 35,
      factors: [
        { key: 'priority', value: 0.55, note: 'важность medium' },
        { key: 'outcome', value: 0.8, note: 'ещё не проверялся' },
        { key: 'instability', value: 0.8, note: 'истории прогонов нет' },
        { key: 'age', value: 1, note: 'ни разу не гоняли' },
        { key: 'impact', value: 0.6, note: 'правки рабочей копии его не касаются' },
      ],
      reason: 'ещё не проверялся; ни разу не гоняли; истории прогонов нет',
      duration: 4,
      hasDuration: true,
      priority: 'medium',
      status: 'unknown',
    },
    {
      groupId: 'gui',
      caseId: 'gui-001',
      key: 'gui:gui-001',
      title: 'Зелёный час назад',
      score: 9,
      factors: [
        { key: 'priority', value: 1, note: 'важность blocker' },
        { key: 'outcome', value: 0.5, note: 'последний прогон зелёный' },
        { key: 'instability', value: 0.6, note: 'стабильность 100% на 9' },
        { key: 'age', value: 0.5, note: 'гоняли сегодня' },
        { key: 'impact', value: 0.6, note: 'правки рабочей копии его не касаются' },
      ],
      reason: 'последний прогон зелёный; гоняли сегодня; важность blocker',
      duration: 20,
      hasDuration: true,
      priority: 'blocker',
      status: 'passed',
    },
  ],
  changedFiles: ['src/login.tsx'],
  checkedAt: '2026-09-08T10:00:00.000Z',
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
  groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: CASES }],
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

/** Запуски прогона: их здесь не должно быть ни одного — бюджет только отмечает. */
const runs = [];

await page.route('**/api/project-tests/run*', async (route) => {
  if (route.request().method() !== 'POST') return route.fulfill({ json: { runs: [] } });
  runs.push(JSON.parse(route.request().postData() ?? '{}'));
  return route.fulfill({ json: { run: { id: 'run-1', status: 'running' } } });
});
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/report*', async (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 3, toAutomate: 0, automated: 0 },
      flaky: [],
      totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0 },
    },
  }),
);
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
await page.route('**/api/project-tests/risk*', async (route) => route.fulfill({ json: RISK }));
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

/** Снимки для отчёта человеку: `SHOTS=<каталог> node tools/qa/check-tests-risk.mjs`. */
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

await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2200);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — риск проверять не на чем.');
  await browser.close();
  process.exit(1);
}

/** Названия кейсов в том порядке, в каком они стоят в таблице. */
const order = async () => {
  const titles = await main.locator('table tbody tr td:nth-child(2) button').allInnerTexts();
  return titles.map((title) => title.trim());
};

const sort = main.getByLabel(/^Порядок$/i).first();
check((await sort.count()) > 0, 'порядок списка выбирается прямо в строке отбора');

const fileOrder = await order();
check(fileOrder[0] === 'Зелёный час назад', 'по умолчанию список лежит так, как написан в файле');
await shot('library-order-file');

await sort.selectOption('risk');
await page.waitForTimeout(800);
const riskOrder = await order();
check(riskOrder[0] === 'Красный со вчера', 'по риску наверх поднимается красный кейс');
check(
  riskOrder[1] === 'Ни разу не гонялся',
  'непроверенный кейс идёт вторым: незнание — тоже риск',
);
check(
  riskOrder[2] === 'Зелёный час назад',
  'зелёный блокер уходит вниз — важность не отменяет истории',
);

// Счёт виден строкой и объясняет себя словами: число без причины бесполезно.
check((await main.getByText(/Риск 71/).count()) > 0, 'счёт риска показан у кейса');
const badge = main.locator('span[title]').filter({ hasText: 'Риск 71' }).first();
check(
  (await badge.count()) > 0 && /красный/i.test((await badge.getAttribute('title')) ?? ''),
  'в подсказке к счёту написано, из чего он вышел',
);
await shot('library-order-risk');

// «У меня N минут»: отмечает кейсы под бюджет и честно пишет, что не влезло.
const minutes = main.getByLabel(/^Минут$/i).first();
check((await minutes.count()) > 0, 'поле бюджета есть в строке отбора');
await minutes.fill('12');
await main
  .getByRole('button', { name: /^Набрать$/i })
  .first()
  .click();
await page.waitForTimeout(800);

const checkedBoxes = await main.locator('table tbody input[type="checkbox"]:checked').count();
check(checkedBoxes === 2, 'в бюджет 12 минут отмечены ровно два кейса (7 + 4)');
check((await main.getByText(/11 из 12 мин/i).count()) > 0, 'набранное и бюджет названы числами');
const left = main.getByText(/Не влезло: 1/i).first();
check((await left.count()) > 0, 'невлезшее названо вслух, а не пропущено молча');
check(
  /Зелёный час назад/.test((await left.getAttribute('title')) ?? ''),
  'в подсказке перечислено, что именно не влезло',
);
check(runs.length === 0, 'бюджет ничего не запускает: он только отмечает');
await shot('library-budget');

// Кнопка прогона берёт ровно отмеченное — тем же путём, что и обычный отбор.
const runSelected = main.getByRole('button', { name: /Прогнать выбранные \(2\)/i }).first();
check((await runSelected.count()) > 0, 'пульт видит отмеченные бюджетом кейсы');

check(problems.length === 0, `ошибок в консоли нет${problems.length ? `: ${problems[0]}` : ''}`);

console.log(bad === 0 ? '\nВсё сходится.' : `\nПлохо: ${bad}.`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
