/**
 * Библиотека тестов на данных, которых на стенде обычно нет: отметка
 * «нестабилен», история результатов кейса, окно группы во время прогона, пустой
 * пульт ручного прохода, отказ на пустой файл импорта и свёрнутая строка отбора.
 *
 * Остальные сценарии тестов подменяют `/flaky` и `/case-history` ПУСТЫМИ — и
 * отметка с историей не рисовались ни в одном прогоне. Здесь они приходят с
 * настоящей формой ответа, а проверяется то, что видит человек:
 *
 * - строка нестабильного кейса несёт отметку, стабильного — нет;
 * - история кейса — таблица прогонов, и ссылка на прогон несёт проект: окно
 *   тестов живёт и в чате, где выбранный в разделе проект может быть другим;
 * - «Изменить группу» во время прогона: опрос каждые 2 с приносит новый вид, и
 *   набранное название не должно стираться серверным;
 * - пустой пульт предлагает пройти группу и ведёт к планам, а не молчит;
 * - пустой выбранный файл получает отказ словами и в сеть не уходит;
 * - свёрнутая панель отбора показывает всё, что сужает или переставляет
 *   список: «С замечаниями», порядок по риску и итог бюджета.
 *
 * Сервер подменён целиком (проект `C:/qa-marks`), стенд не пишется.
 * Запуск: `node tools/qa/check-tests-marks.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888). `SHOTS=<каталог>` — кадры.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA отметки', path: 'C:/qa-marks' };
const at = (day) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;

const browser = await chromium.launch();
// `WIDTH=1100` — та же проверка на узком экране (пульт прогона в две строки).
const context = await browser.newContext({
  viewport: { width: Number(process.env.WIDTH ?? 1600), height: 1000 },
});
// HMR Vite перезагрузил бы страницу посреди прогона, если рядом правят код.
await context.routeWebSocket(
  (url) => url.pathname === '/' && url.port === '8888',
  () => undefined,
);
const page = await context.newPage();
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const shotsDir = process.env.SHOTS;
const shot = async (name) => {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
};

/**
 * Стенд, чей сервер перезапускают рядом, отвечает 502 на настройки панели, и
 * поверх раздела встаёт «Панель не загрузилась». Это не предмет проверки:
 * ждём сервер и жмём «Повторить», а не краснеем на чужом перезапуске.
 */
const settle = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const retry = page.getByRole('dialog').getByRole('button', { name: 'Повторить' });
    if ((await retry.count()) === 0) return;
    await page.waitForTimeout(3000);
    await retry
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(1500);
  }
};

const testCase = (id, title, status, extra = {}) => ({
  id,
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открылось' }],
  status,
  duration: 5,
  source: 'agent',
  ...extra,
});

/** Вид проекта. `polls` меняет статус кейса на каждом чтении — как настоящий прогон. */
let polls = 0;
let running = false;
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
  branch: 'main',
  ...(running
    ? {
        run: {
          id: 'run-live',
          projectPath: PROJECT.path,
          mode: 'run',
          actor: 'agent',
          groupId: 'gui',
          status: 'running',
          startedAt: at(26),
          log: '',
          tokens: 0,
          costUsd: 0,
        },
      }
    : {}),
  groups: [
    {
      id: 'gui',
      title: 'Интерфейс',
      description: 'Проверки экрана входа',
      file: '.agent/tests/gui.tests.json',
      cases: [
        testCase('gui-001', 'Вход существующим пользователем', 'passed'),
        testCase('gui-002', 'Мигающий вход по ссылке', 'failed'),
        testCase('gui-003', 'Открытие настроек', polls % 2 === 0 ? 'unknown' : 'failed'),
      ],
    },
  ],
});

const RUNS = [
  {
    id: 'run-3',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt: at(20),
    finishedAt: at(20),
    summary: { total: 3, passed: 2, failed: 1, skipped: 0, blocked: 0 },
  },
  {
    id: 'run-2',
    mode: 'manual',
    actor: 'human',
    status: 'done',
    startedAt: at(18),
    finishedAt: at(18),
    summary: { total: 3, passed: 3, failed: 0, skipped: 0, blocked: 0 },
  },
];

const HISTORY = {
  groupId: 'gui',
  caseId: 'gui-002',
  entries: [
    {
      runId: 'run-3',
      startedAt: at(20),
      mode: 'run',
      actor: 'agent',
      status: 'failed',
      points: 1,
      failure: { step: 2, expected: 'Вошёл', actual: 'Ссылка протухла на полпути' },
    },
    {
      runId: 'run-2',
      startedAt: at(18),
      mode: 'manual',
      actor: 'human',
      status: 'passed',
      points: 2,
    },
    { runId: 'run-1', startedAt: at(15), mode: 'run', actor: 'agent', status: 'failed', points: 1 },
  ],
  flaky: { isFlaky: true, flips: 2, runs: 3 },
};

const imports = [];
await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/projects', (route) =>
  route.request().method() === 'GET'
    ? route.fulfill({ json: [{ id: 'qa-marks', name: PROJECT.name, path: PROJECT.path }] })
    : route.fallback(),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      { path: PROJECT.path, name: PROJECT.name, exists: true, lastActivity: at(20), chats: [] },
    ],
  }),
);
// Запись прогона по ссылке из истории: раскрытая карточка тянет её отдельно.
await page.route('**/api/project-tests/run?*', (route) => {
  const id = new URL(route.request().url()).searchParams.get('id');
  const record = RUNS.find((item) => item.id === id);
  if (!record) return route.fulfill({ status: 404, json: { message: 'нет' } });
  return route.fulfill({
    json: {
      run: {
        ...record,
        results: [
          { pointId: 'gui|gui-001', groupId: 'gui', caseId: 'gui-001', status: 'passed' },
          { pointId: 'gui|gui-002', groupId: 'gui', caseId: 'gui-002', status: 'passed' },
        ],
      },
    },
  });
});
await page.route('**/api/project-tests/runs*', (route) => route.fulfill({ json: { runs: RUNS } }));
await page.route('**/api/project-tests/report*', (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 3, toAutomate: 0, automated: 0 },
      flaky: [],
      failures: [],
      evidence: { failed: 0, proven: 0, detailed: 0, missing: [], flaky: [] },
      releases: [],
      totals: { runs: 2, tokens: 0, costUsd: 0, durationMs: 0, muted: 0 },
    },
  }),
);
await page.route('**/api/project-tests/coverage*', (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/defects/refresh*', (route) =>
  route.fulfill({ json: { checked: 0, closed: 0, recheck: [] } }),
);
await page.route('**/api/project-tests/lint*', (route) =>
  route.fulfill({
    json: {
      findings: [
        {
          rule: 'not-run',
          severity: 'info',
          groupId: 'gui',
          caseId: 'gui-003',
          title: 'Открытие настроек',
          message: 'Не гонялся 120 дней.',
        },
      ],
      byRule: [{ rule: 'not-run', severity: 'info', title: 'Давно не гонялся', count: 1 }],
      duplicates: [],
      checked: 3,
      checkedAt: at(20),
    },
  }),
);
await page.route('**/api/project-tests/quarantine*', (route) =>
  route.fulfill({
    json: {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: at(20),
    },
  }),
);
await page.route('**/api/project-tests/risk*', (route) =>
  route.fulfill({ json: { items: [], checkedAt: at(20) } }),
);
await page.route('**/api/project-tests/plans*', (route) => route.fulfill({ json: { plans: [] } }));
await page.route('**/api/project-tests/manual*', (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests/impact*', (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests/import/**', (route) => {
  imports.push(route.request().url());
  return route.fulfill({ json: { imported: 0, skipped: 0, view: view() } });
});
await page.route('**/api/project-tests?*', (route) => {
  polls += 1;
  return route.fulfill({ json: view() });
});
await page.route('**/api/project-tests/flaky*', (route) =>
  route.fulfill({
    json: {
      window: 10,
      minFlips: 2,
      cases: [{ groupId: 'gui', caseId: 'gui-002', isFlaky: true, flips: 2, runs: 3 }],
    },
  }),
);
await page.route('**/api/project-tests/case-history*', (route) => route.fulfill({ json: HISTORY }));

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate((project) => {
  localStorage.setItem(
    'agentdeck:workspace',
    JSON.stringify({
      projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
      activeTabId: project.path.toLowerCase(),
      views: {},
    }),
  );
  localStorage.setItem('agentdeck:tests-project', project.path.toLowerCase());
}, PROJECT);

await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2200);
await settle();

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('Мигающий вход по ссылке').count()) > 0;
check(opened, 'библиотека открылась на проверочном проекте');
if (!opened) {
  await shot('00-not-opened');
  await browser.close();
  process.exit(1);
}

// 1. Отметка «нестабилен» — только у мигающего кейса.
const rowOf = (title) => main.locator('tr', { hasText: title }).first();
check(
  (await rowOf('Мигающий вход по ссылке').getByText('нестабилен', { exact: true }).count()) === 1,
  'нестабильный кейс помечен в строке',
);
check(
  (await rowOf('Вход существующим пользователем').getByText('нестабилен').count()) === 0,
  'стабильный кейс без отметки',
);
await shot('01-flaky-mark');

// 2. История результатов в карточке кейса и ссылка на прогон с проектом.
await rowOf('Мигающий вход по ссылке')
  .getByRole('button', { name: 'Мигающий вход по ссылке' })
  .click();
await page.waitForTimeout(800);
const dialog = page.getByRole('dialog').last();
check((await dialog.getByText('История результатов').count()) > 0, 'в карточке есть история');
check(
  (await dialog.getByText('Ссылка протухла на полпути').count()) > 0,
  'причина провала названа в строке истории',
);
const runLinks = dialog.locator('a[href*="run="]');
check((await runLinks.count()) === 3, 'у каждого прогона истории своя ссылка');
const href = (await runLinks.first().getAttribute('href')) ?? '';
check(
  href.includes('run=run-3') && /[?&]project=C%3A%2Fqa-marks|[?&]project=C:\/qa-marks/.test(href),
  `ссылка на прогон несёт проект (${href})`,
);
await dialog.getByText('История результатов').scrollIntoViewIfNeeded();
await shot('02-case-history');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 3. Свёрнутая строка отбора: «С замечаниями», порядок и бюджет видны без панели.
await main.getByRole('button', { name: /^Фильтры/ }).click();
await page.waitForTimeout(300);
await main.getByRole('switch', { name: 'С замечаниями' }).click();
await main.getByLabel('Порядок').selectOption('risk');
await main.getByLabel('Минут').fill('7');
await main.getByRole('button', { name: 'Набрать' }).click();
await page.waitForTimeout(300);
await main.getByRole('button', { name: /^Фильтры/ }).click();
await page.waitForTimeout(300);
const toggleText = (await main.getByRole('button', { name: /^Фильтры/ }).textContent()) ?? '';
const count = Number(/·\s*(\d+)/.exec(toggleText)?.[1] ?? 0);
const chips = main.getByRole('button', { name: /^Снять условие/ });
check(
  count > 0 && (await chips.count()) === count,
  `у каждого условия счётчика своя плашка (${toggleText.trim()}, плашек ${await chips.count()})`,
);
check(
  (await main.getByRole('button', { name: /Снять условие «С замечаниями»/ }).count()) === 1,
  '«С замечаниями» видно плашкой в свёрнутой строке',
);
check(
  (await main.getByRole('button', { name: /Снять условие «Порядок: По риску»/ }).count()) === 1,
  'порядок по риску виден плашкой в свёрнутой строке',
);
check(
  (await main.getByText(/^Набрано \d+ кейс/).count()) === 1,
  'итог бюджета виден при свёрнутой панели',
);
await shot('03-filters-collapsed');
// Снять — крестиками; без плашек (старая строка) — открыть панель и снять там,
// чтобы следующие сценарии шли на чистом отборе.
for (let left = await chips.count(); left > 0; left = await chips.count()) {
  await chips.first().click();
}
await page.waitForTimeout(300);
if ((await main.getByRole('button', { name: 'Сбросить отбор' }).count()) > 0) {
  check(false, 'после крестиков отбор всё ещё стоит');
  await main.getByRole('button', { name: 'Сбросить отбор' }).click();
}
await page.waitForTimeout(300);
check((await chips.count()) === 0, 'крестики снимают условия, плашек не осталось');

// 4. «Изменить группу» во время прогона: опрос не стирает набранное.
// Прогон идёт с первой загрузки: вид опрашивается каждые 2 с, как на стенде.
running = true;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await settle();
await main.getByRole('button', { name: 'Изменить группу' }).click();
await page.waitForTimeout(400);
const groupDialog = page.getByRole('dialog').last();
const titleField = groupDialog.getByLabel('Название', { exact: true });
check((await titleField.inputValue()) === 'Интерфейс', 'окно группы открылось с названием группы');
await titleField.fill('Интерфейс входа');
const pollsBefore = polls;
await page.waitForTimeout(4800);
check(polls > pollsBefore, `вид перечитывался во время прогона (${polls - pollsBefore} раз)`);
check(
  (await titleField.inputValue()) === 'Интерфейс входа',
  'набранное название пережило опрос прогона',
);
await shot('04-group-form-during-run');
await groupDialog.getByRole('button', { name: 'Отмена' }).click();
running = false;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await settle();

// 5. Пустой пульт — не тупик.
await main.getByRole('button', { name: 'Ручной проход' }).click();
await page.waitForTimeout(600);
const runner = page.getByRole('dialog').last();
check(
  (await runner.getByText('Ручной проход не запущен').count()) > 0,
  'пульт без сессии так и говорит',
);
check(
  (await runner.getByRole('button', { name: /Пройти «Интерфейс» — кейсов: 3/ }).count()) === 1,
  'пульт предлагает пройти группу со счётом кейсов',
);
check(
  (await runner.getByRole('button', { name: 'Открыть тест-планы' }).count()) === 1,
  'пульт ведёт к тест-планам',
);
await shot('05-runner-empty');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 6. Пустой файл импорта: отказ словами, запроса нет.
await main.getByRole('button', { name: 'Обмен' }).click();
await page.waitForTimeout(500);
const exchange = page.getByRole('dialog').last();
await exchange
  .locator('input[type="file"]')
  .first()
  .setInputFiles({ name: 'empty-results.xml', mimeType: 'text/xml', buffer: Buffer.from('') });
await page.waitForTimeout(600);
check(
  (await exchange.getByText('Файл «empty-results.xml» пуст — импортировать нечего.').count()) === 1,
  'пустой файл получил отказ с именем файла',
);
check(imports.length === 0, 'пустой файл в сеть не ушёл');
await shot('06-exchange-empty-file');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 7. Ссылка из истории кейса: вкладка прогонов, запись раскрыта, параметр
// проекта снят после выбора (дальше это обычный выбор проекта).
await rowOf('Мигающий вход по ссылке')
  .getByRole('button', { name: 'Мигающий вход по ссылке' })
  .click();
await page.waitForTimeout(800);
await page.getByRole('dialog').last().locator('a[href*="run=run-2"]').first().click();
await page.waitForTimeout(1500);
const landed = new URL(page.url());
check(
  landed.searchParams.get('tab') === 'runs' && landed.searchParams.get('run') === 'run-2',
  `ссылка открыла вкладку прогонов на записи (${landed.search})`,
);
check(!landed.searchParams.has('project'), 'проект из ссылки выбран, параметр снят');
check((await page.locator('#run-body-run-2').count()) === 1, 'запись прогона по ссылке раскрыта');
await shot('07-run-link');

check(problems.length === 0, `страница без ошибок JS${problems.length ? `: ${problems[0]}` : ''}`);
await browser.close();
console.log(bad === 0 ? '\nОтметки и окна библиотеки в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
