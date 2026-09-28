/**
 * Карточка папки e2e в разделе «Тесты»: завести, сверить, убрать — и
 * «Сгенерировать», которое просит у агента настоящие спеки.
 *
 * Ответы сервера подменены целиком (`page.route`): проверяемый проект живёт
 * только в этом сквозняке, реестр стенда и файлы на диске не трогаются. Что
 * делает сервер на настоящем репозитории, проверяют интеграционные тесты
 * `routes/project-tests/e2e-routes.integration.test.ts`; здесь — что человек
 * видит и что уходит на сервер по его нажатию.
 *
 * Вариации сверх счастливого пути: медленная сверка (кнопка занята, пока идёт),
 * отказ 409 с чужими файлами (подтверждение в карточке, второй запрос с
 * `force=1`), отказ сверки кодом (текст из словаря, а не код), своя папка
 * проекта (убрать её нельзя — кнопки нет).
 *
 * Запуск: `node tools/qa/check-tests-e2e.mjs` при поднятом `pnpm dev`.
 * Снимки: `SHOTS=<каталог> node tools/qa/check-tests-e2e.mjs`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект e2e', path: 'C:/qa-e2e-project' };
const NOW = '2026-09-26T10:00:00.000Z';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Отказы 409/400 подстроены сценарием: браузер пишет о них сам, это не ошибка страницы.
  if (/status of (409|400)/.test(message.text())) return;
  problems.push(message.text());
});

const CASE = {
  id: 'gui-001',
  type: 'case',
  title: 'Открытие главной',
  steps: [{ action: 'открыть' }],
  status: 'unknown',
  readiness: 'ready',
  updatedAt: NOW,
};

const MISSING = { state: 'missing', framework: 'unknown', specs: 0, excluded: false, git: true };
const CREATED = {
  state: 'created',
  dir: 'e2e',
  origin: 'panel',
  framework: 'playwright',
  specs: 0,
  excluded: true,
  git: true,
};

let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [{ id: 'local', title: 'Локально', isDefault: true }],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  drafts: [],
  branch: 'main',
  groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: [CASE] }],
  autoAcceptDrafts: false,
  e2e: MISSING,
};

/** Что уходило на сервер — по этому видно, что нажатие дошло. */
const sent = {
  create: [],
  remove: [],
  sync: 0,
  run: undefined,
  e2eRun: [],
  e2eStop: 0,
  syncBodies: [],
  runsFetch: 0,
  flakyFetch: 0,
};
/** Ответ на «Прогнать автотесты»: ok — прогон пошёл, busy — 409 от сервера. */
let e2eRunMode = 'ok';
// История, которую отдаёт сервер: пусто до прогона, после — запись автотестов
// панели и старый импорт CI без поля origin (так писались все импорты раньше).
let runsList = [];
const historyRecord = (id, startedAt, extra) => ({
  id,
  mode: 'import',
  actor: 'ci',
  status: 'done',
  startedAt,
  finishedAt: startedAt,
  results: [],
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, blocked: 0 },
  ...extra,
});
const E2E_COMMAND = 'npx --no-install playwright test --reporter=list,junit';
let syncMode = 'ok';
// Два отказа: первый снимается «Отменой» (F-322), второй — подтверждением.
let removeRefusals = 2;

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: true, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: NOW,
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/project-tests/e2e/sync*', async (route) => {
  sent.sync += 1;
  sent.syncBodies.push(route.request().postDataJSON());
  // Медленная сверка: кнопка обязана быть занята, пока ответа нет.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (syncMode === 'missing') {
    return route.fulfill({
      status: 400,
      json: { message: 'Папки e2e в проекте нет.', messageCode: 'e2e-missing' },
    });
  }
  view = {
    ...view,
    e2e: { ...view.e2e, specs: 2 },
    // Повторная сверка группу не задваивает — как и настоящий сервер.
    groups: [
      ...view.groups.filter((group) => group.id !== 'auth'),
      { id: 'auth', title: 'Вход', file: '.agent/tests/auth.tests.json', cases: [] },
    ],
  };
  return route.fulfill({
    json: {
      sync: {
        dir: 'e2e',
        files: 2,
        tests: 5,
        added: 4,
        linked: 1,
        groups: ['auth'],
        skipped: [{ file: 'e2e/roles.spec.ts', reason: 'dynamic-title:3' }],
        missing: [{ groupId: 'gui', caseId: 'gui-001', file: 'e2e/gui.spec.ts' }],
      },
      view,
    },
  });
});

await page.route('**/api/project-tests/e2e/run/stop*', async (route) => {
  sent.e2eStop += 1;
  view = { ...view, e2eRun: { ...view.e2eRun, status: 'stopped', finishedAt: NOW } };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/e2e/run*', async (route) => {
  sent.e2eRun.push(route.request().postDataJSON());
  if (e2eRunMode === 'busy') {
    return route.fulfill({
      status: 409,
      json: { message: 'Автотесты уже идут.', messageCode: 'e2e-run-busy' },
    });
  }
  view = {
    ...view,
    e2eRun: {
      status: 'running',
      command: E2E_COMMAND,
      startedAt: NOW,
      log: 'Running 3 tests using 1 worker\n',
    },
  };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/e2e*', async (route) => {
  const request = route.request();
  if (request.method() === 'POST') {
    sent.create.push(request.postDataJSON());
    view = { ...view, e2e: CREATED };
    return route.fulfill({ json: view });
  }
  if (request.method() === 'DELETE') {
    const url = new URL(request.url());
    sent.remove.push({ path: url.searchParams.get('path'), force: url.searchParams.get('force') });
    if (url.searchParams.get('force') !== '1' && removeRefusals > 0) {
      removeRefusals -= 1;
      return route.fulfill({
        status: 409,
        json: {
          message: 'В папке e2e лежат чужие файлы (2).',
          messageCode: 'e2e-folder-not-empty',
          params: { count: 2 },
        },
      });
    }
    view = { ...view, e2e: MISSING };
    return route.fulfill({ json: view });
  }
  return route.fulfill({ json: view.e2e });
});

await page.route('**/api/project-tests/run', async (route) => {
  sent.run = route.request().postDataJSON();
  return route.fulfill({ json: view });
});
await page.route('**/api/project-tests/runs*', (route) => {
  sent.runsFetch += 1;
  return route.fulfill({ json: { runs: runsList } });
});
await page.route('**/api/project-tests/report*', (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 0, toAutomate: 0, automated: 0 },
      flaky: [],
      failures: [],
      evidence: { failed: 0, proven: 0, detailed: 0, missing: [], flaky: [] },
      releases: [],
      totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0, muted: 0 },
    },
  }),
);
await page.route('**/api/project-tests/release*', (route) =>
  route.fulfill({ json: { releases: [] } }),
);
await page.route('**/api/project-tests/coverage*', (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/lint*', (route) =>
  route.fulfill({
    json: { findings: [], byRule: [], duplicates: [], checked: 0, checkedAt: NOW },
  }),
);
await page.route('**/api/project-tests/quarantine*', (route) =>
  route.fulfill({
    json: {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: NOW,
    },
  }),
);
await page.route('**/api/project-tests/risk*', (route) =>
  route.fulfill({ json: { items: [], checkedAt: NOW } }),
);
await page.route('**/api/project-tests/plans*', (route) => route.fulfill({ json: { plans: [] } }));
await page.route('**/api/project-tests/manual*', (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests/impact*', (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests/flaky*', (route) => {
  sent.flakyFetch += 1;
  return route.fulfill({ json: { window: 10, minFlips: 2, cases: [] } });
});
await page.route('**/api/project-tests/case-history*', (route) =>
  route.fulfill({
    json: { groupId: '', caseId: '', entries: [], flaky: { isFlaky: false, flips: 0, runs: 0 } },
  }),
);
await page.route('**/api/project-tests?*', (route) => route.fulfill({ json: view }));

let bad = 0;
const rows = [];
const check = (ok, text) => {
  rows.push([ok ? 'ок' : 'ПЛОХО', text]);
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const shotsDir = process.env.SHOTS;
const shot = async (name, target = card) => {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  // Вкладка «Прогоны» карточки не несёт: её снимают целиком, иначе снимок ждал
  // карточку до таймаута и валил весь прогон с SHOTS.
  await target.screenshot({ path: join(shotsDir, `${name}.png`) });
};

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

const card = page.getByTestId('tests-e2e-card');
try {
  await card.waitFor({ timeout: 10_000 });
} catch {
  check(false, 'карточка папки e2e появилась в разделе');
  await browser.close();
  process.exit(1);
}

// 1. Папки нет — карточка говорит об этом и предлагает завести.
check(
  (await card.getByText(/Папки e2e в проекте нет/).count()) > 0,
  'нет папки: карточка говорит словами',
);
check(
  (await card.getByRole('heading', { name: 'Папка автотестов' }).count()) === 1,
  'у карточки есть заголовок',
);
check(
  (await card.getByText(/Кнопка заведёт e2e\/ с конфигом Playwright/).count()) === 1,
  'что сделает «Создать папку» — видимым текстом, не только подсказкой',
);
await shot('e2e-missing');
await card.getByRole('button', { name: 'Создать папку' }).click();
await card.getByText(/заведена панелью/).waitFor({ timeout: 5000 });
check(
  sent.create[0]?.path === PROJECT.path,
  `создание ушло открытому проекту: ${sent.create[0]?.path}`,
);
check(
  (await card.getByText(/скрыта от git/).count()) > 0,
  'заведённая папка помечена «скрыта от git»',
);
check((await card.getByText(/Playwright/).count()) > 0, 'назван фреймворк');
await shot('e2e-created');

// 2. Сверка: медленный ответ держит кнопку занятой, итог — словами.
const syncButton = card.getByRole('button', { name: 'Обновить из папки' });
await syncButton.click();
await page.waitForTimeout(400);
const busy =
  (await syncButton.getAttribute('aria-busy')) === 'true' || (await syncButton.isDisabled());
check(busy, 'пока сверка идёт, кнопка занята');
await card.getByText(/Сверено:/).waitFor({ timeout: 5000 });
const summary = (await card.getByRole('status').textContent()) ?? '';
check(/новых кейсов 4/.test(summary) && /привязано 1/.test(summary), `итог сверки: ${summary}`);
check(/1 кейс потерял свой тест/.test(summary), 'исчезнувший тест назван');
check(
  /Не стали кейсами: 1 — имя теста собирается из переменных/.test(summary),
  'непонятый без запуска тест назван словами тестировщика',
);
check(
  (await page.getByText('Вход', { exact: true }).count()) > 0,
  'заведённая сверкой группа появилась в списке тем же ответом',
);
await shot('e2e-synced');

// 3. Отказ сверки кодом — текст из словаря, а не код.
syncMode = 'missing';
await syncButton.click();
await card.getByRole('alert').waitFor({ timeout: 5000 });
const refusal = (await card.getByRole('alert').textContent()) ?? '';
check(/заведите её в разделе/.test(refusal), `отказ сверки — словами: ${refusal}`);
check(!/e2e-missing/.test(refusal), 'код отказа наружу не торчит');
syncMode = 'ok';

// 3а. Монорепозиторий: другая найденная папка берётся кнопкой, выбор уходит серверу.
view = { ...view, e2e: { ...view.e2e, candidates: ['apps/web/e2e'] } };
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
const choose = card.getByRole('button', { name: 'Взять apps/web/e2e/' });
await choose.waitFor({ timeout: 5000 });
await choose.click();
await card.getByText(/Сверено:/).waitFor({ timeout: 5000 });
check(
  sent.syncBodies.at(-1)?.dir === 'apps/web/e2e' && sent.syncBodies.at(-1)?.path === PROJECT.path,
  `выбор папки ушёл сверкой с dir: ${JSON.stringify(sent.syncBodies.at(-1))}`,
);
check(sent.syncBodies[0]?.dir === undefined, 'обычная сверка dir не шлёт');
view = { ...view, e2e: { ...view.e2e, candidates: undefined } };

// 4. Убрать: 409 с чужими файлами → подтверждение в карточке → force=1.
await card.getByRole('button', { name: 'Убрать папку' }).click();
await card.getByText(/2 чужих файла/).waitFor({ timeout: 5000 });
check(sent.remove[0]?.force === null, 'первая попытка — без force');
// F-322: «Отмена» снимает и вопрос, и сам отказ — иначе строка ошибки 409
// оставалась под карточкой, будто уборка сломалась.
await card.getByRole('button', { name: 'Отмена', exact: true }).click();
await page.waitForTimeout(300);
const leftAlerts = await card.getByRole('alert').allTextContents();
check(
  leftAlerts.length === 0,
  `после «Отмены» под карточкой нет отказа: ${leftAlerts.join(' | ')}`,
);
await shot('e2e-remove-cancelled');
await card.getByRole('button', { name: 'Убрать папку' }).click();
await card.getByText(/2 чужих файла/).waitFor({ timeout: 5000 });
check(sent.remove[1]?.force === null, 'вторая попытка — снова без force');
await shot('e2e-remove-confirm');
await card.getByRole('button', { name: 'Убрать вместе с ними' }).click();
await card.getByText(/Папки e2e в проекте нет/).waitFor({ timeout: 5000 });
check(sent.remove[2]?.force === '1', 'подтверждение уходит с force=1');
check(
  (await card.getByRole('button', { name: 'Создать папку' }).count()) === 1,
  'снова можно завести',
);

// 5. Своя папка проекта: убрать нельзя — кнопки нет.
view = {
  ...view,
  e2e: {
    state: 'found',
    dir: 'tests/e2e',
    origin: 'folder',
    framework: 'playwright',
    specs: 3,
    excluded: false,
    git: true,
  },
};
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
await card.getByText(/своя папка проекта/).waitFor({ timeout: 5000 });
check(
  (await card.getByRole('button', { name: 'Убрать папку' }).count()) === 0,
  'свою папку убрать нельзя',
);
check((await card.getByText(/3 файла тестов/).count()) > 0, 'число файлов тестов со склонением');

// 6. «Сгенерировать» просит настоящие спеки; без адреса стенда — подсказка об этом.
const generate = page.getByRole('button', { name: 'Сгенерировать кейсы' }).first();
const hint = (await generate.getAttribute('title')) ?? '';
check(
  /нет адреса стенда/.test(hint),
  `без адреса стенда подсказка говорит об этом: ${hint.slice(0, 60)}…`,
);
await generate.click();
await page.waitForTimeout(800);
check(
  sent.run?.mode === 'generate' && sent.run?.e2e === true,
  `генерация ушла с e2e: ${JSON.stringify(sent.run)}`,
);

// 7. «Прогнать автотесты»: без агента, ход — в карточке, итог — словами, история перечитана.
// История уже в кэше (staleTime 30 с): без сброса после прогона вкладка показала бы старую.
const tab = (name) => page.getByRole('button', { name, exact: true }).first();
await tab('Прогоны').click();
await page.waitForTimeout(800);
await tab('Библиотека').click();
await card.waitFor({ timeout: 5000 });
const runButton = card.getByRole('button', { name: 'Прогнать автотесты' });
check(await runButton.isEnabled(), 'папка с тестами и каркасом: прогон доступен');
check(
  /без агента и без токенов/.test((await runButton.getAttribute('title')) ?? ''),
  'подсказка говорит, что агента не будет',
);
await runButton.click();
await card
  .getByText('Идёт прогон автотестов — команда и её вывод ниже.')
  .waitFor({ timeout: 5000 });
check(
  (await card.getByText(`Команда: ${E2E_COMMAND}`, { exact: false }).count()) === 1,
  'команда — в раскрытом выводе, а не в строке хода',
);
check(
  sent.e2eRun[0]?.path === PROJECT.path,
  `прогон ушёл открытому проекту: ${JSON.stringify(sent.e2eRun[0])}`,
);
check(
  (await card.getByRole('button', { name: 'Остановить' }).count()) === 1,
  'пока идёт — кнопка «Остановить»',
);
check((await card.getByText(/Running 3 tests/).count()) > 0, 'вывод команды виден, пока идёт');
await shot('e2e-run-running');
const runsBefore = sent.runsFetch;
const flakyBefore = sent.flakyFetch;
// Сервер закончил: вид перечитывается сам, без F5 — опрос идёт, пока e2eRun бежит.
view = {
  ...view,
  e2eRun: {
    ...view.e2eRun,
    status: 'done',
    finishedAt: NOW,
    exitCode: 1,
    runId: 'run-e2e-1',
    imported: { read: 3, matched: 2, unmatched: 1 },
    summary: { total: 3, passed: 2, failed: 1, skipped: 0, blocked: 0 },
    unmatchedNames: ['Корзина › пустая корзина'],
    log: 'Running 3 tests using 1 worker\n  2 passed, 1 failed\n',
  },
};
runsList = [
  historyRecord('run-e2e-1', NOW, { origin: 'e2e', scope: `Автотесты папки e2e: ${E2E_COMMAND}` }),
  historyRecord('run-ci-old', '2026-09-25T10:00:00.000Z', { scope: 'Импорт результатов (junit)' }),
];
await card.getByText('Упало 1 из 3, прошло 2.').waitFor({ timeout: 8000 });
check(true, 'итог прогона пришёл опросом: сколько упало, а не «Готово»');
check((await card.getByText(/Готово/).count()) === 0, 'над красным набором нет «Готово»');
// Отметки «нестабилен» считаются по той же истории: их подпись следит только
// за прогоном агента, и после автотестов бейджи оставались прежними.
await page.waitForTimeout(500);
check(
  sent.flakyFetch > flakyBefore,
  `отметки «нестабилен» перечитаны после автотестов (${flakyBefore} → ${sent.flakyFetch})`,
);
check(
  (await card.getByText(/Без кейса \(1\): Корзина › пустая корзина/).count()) === 1,
  'тест без кейса назван по имени',
);
check(
  (await card.getByText(/код(ом)? выхода|с кодом 1/i).count()) === 0,
  'код 1 при упавших тестах не показан',
);
await shot('e2e-run-done');
const openRun = card.getByRole('link', { name: 'Открыть прогон в истории' });
check(
  /run=run-e2e-1/.test((await openRun.getAttribute('href')) ?? ''),
  'ссылка ведёт на запись прогона',
);
await openRun.click();
await page.waitForTimeout(800);
check(
  (await page.locator('#run-card-run-e2e-1 button[aria-expanded="true"]').count()) > 0,
  'по ссылке запись прогона открыта раскрытой',
);
check(
  sent.runsFetch > runsBefore,
  `вкладка «Прогоны» перечитала историю после прогона (${runsBefore} → ${sent.runsFetch})`,
);
// Автотесты панели и отчёт CI — оба импорт; подпись и отбор их разводят.
const runCards = page.locator('[id^="run-card-"]');
await runCards.first().waitFor({ timeout: 5000 });
const headOf = async (id) =>
  (await page.locator(`#run-card-${id} button`).first().innerText()).replace(/\s+/g, ' ');
const e2eHead = await headOf('run-e2e-1');
const ciHead = await headOf('run-ci-old');
check(
  /автотесты/.test(e2eHead) && /панель/.test(e2eHead) && !/импорт/.test(e2eHead),
  `запись автотестов подписана «автотесты» · «панель»: ${e2eHead}`,
);
check(
  /импорт/.test(ciHead) && /CI/.test(ciHead),
  `старый импорт без поля — «импорт» · «CI»: ${ciHead}`,
);
const originFilter = page.getByLabel('Записи', { exact: true });
check((await originFilter.count()) === 1, 'в истории оба источника — отбор «Записи» на месте');
await originFilter.selectOption({ label: 'автотесты панели' });
await page.waitForTimeout(300);
check(
  (await runCards.count()) === 1 && (await page.locator('#run-card-run-e2e-1').count()) === 1,
  'отбор «автотесты панели» оставил одну запись панели',
);
await originFilter.selectOption({ label: 'импорт из CI' });
await page.waitForTimeout(300);
check(
  (await runCards.count()) === 1 && (await page.locator('#run-card-run-ci-old').count()) === 1,
  'отбор «импорт из CI» оставил старый импорт',
);
await originFilter.selectOption({ label: 'все' });
await shot('e2e-run-history', page.locator('main'));
await tab('Библиотека').click();
await card.waitFor({ timeout: 5000 });

// 8. Остановка и отказ: «Остановлено», 409 сервера и «нет отчёта» — словами.
await runButton.click();
await card.getByRole('button', { name: 'Остановить' }).click();
await card.getByText(/Остановлено/).waitFor({ timeout: 5000 });
check(sent.e2eStop === 1, 'остановка дошла до сервера');
e2eRunMode = 'busy';
await runButton.click();
await card.getByText(/уже идут — дождитесь конца/).waitFor({ timeout: 5000 });
check((await card.getByText(/e2e-run-busy/).count()) === 0, 'отказ «уже идут» — словами, без кода');
e2eRunMode = 'ok';
view = {
  ...view,
  e2eRun: {
    status: 'error',
    command: E2E_COMMAND,
    startedAt: NOW,
    finishedAt: NOW,
    exitCode: 1,
    log: "'npx' is not recognized\n",
    error: 'Отчёт не появился (код выхода 1)',
    errorCode: 'e2e-run-no-report',
  },
};
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
await card.getByText(/Отчёт не появился — команда не нашлась/).waitFor({ timeout: 5000 });
check(true, 'нет отчёта: причина из словаря по коду');
await shot('e2e-run-error');

// 8а. Папка панели, пока идут автотесты (и пока остановленные закрываются):
// «Убрать папку» закрыта — «вместе с ними» стёрла бы спеки из-под раннера.
view = {
  ...view,
  e2e: { ...CREATED, specs: 2 },
  e2eRun: { status: 'stopped', command: E2E_COMMAND, startedAt: NOW, log: '' },
};
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
const removeButton = card.getByRole('button', { name: 'Убрать папку' });
await removeButton.waitFor({ timeout: 5000 });
check(await removeButton.isDisabled(), 'автотесты ещё закрываются: «Убрать папку» закрыта');
const removesBefore = sent.remove.length;
await removeButton.click({ force: true }).catch(() => undefined);
await page.waitForTimeout(300);
check(sent.remove.length === removesBefore, 'закрытая кнопка запроса на уборку не шлёт');
view = { ...view, e2eRun: { ...view.e2eRun, finishedAt: NOW } };
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
await removeButton.waitFor({ timeout: 5000 });
check(await removeButton.isEnabled(), 'прогон закрыт: «Убрать папку» снова открыта');
await shot('e2e-remove-after-run');

// 9. Каркас не узнан — кнопка закрыта, причина в подсказке.
view = { ...view, e2eRun: undefined, e2e: { ...view.e2e, framework: 'unknown' } };
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
const closed = card.getByRole('button', { name: 'Прогнать автотесты' });
await closed.waitFor({ timeout: 5000 });
check(await closed.isDisabled(), 'каркас не узнан: прогон закрыт');
check(/панель не угадывает/.test((await closed.getAttribute('title')) ?? ''), 'и сказано почему');

// 10. Папки нет, но проект назвал свою команду (automation.json): прогон открыт,
// команда названа, «Только группа» шлёт groupId; группа без автотестов — закрыта.
const OWN = 'node tools/qa/junit-run.mjs {files}';
view = { ...view, e2e: MISSING, automation: { command: OWN } };
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
const ownRun = card.getByRole('button', { name: 'Прогнать автотесты' });
await ownRun.waitFor({ timeout: 5000 });
check(await ownRun.isEnabled(), 'папки нет, своя команда есть: прогон открыт');
check(
  (await card.getByText(`Своя команда проекта (.agent/tests/automation.json): ${OWN}`).count()) ===
    1,
  'своя команда названа под кнопкой',
);
const onlyGroup = card.getByRole('button', { name: /^Только «/ });
check((await onlyGroup.count()) === 1, 'у открытой группы — «Только «…»»');
check(await onlyGroup.isDisabled(), 'у кейсов группы нет automation.file: «Только» закрыта');
check(/нет автотеста/.test((await onlyGroup.getAttribute('title')) ?? ''), 'и сказано почему');
view = {
  ...view,
  groups: view.groups.map((group) => ({
    ...group,
    cases: group.cases.map((item) => ({
      ...item,
      automation: { status: 'automated', file: 'tools/qa/check-open.mjs' },
    })),
  })),
};
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ timeout: 10_000 });
await onlyGroup.waitFor({ timeout: 5000 });
const groupTitle = (await onlyGroup.textContent())?.match(/«(.+)»/)?.[1];
const activeId = view.groups.find((group) => group.title === groupTitle)?.id;
check(await onlyGroup.isEnabled(), `автотесты у кейсов есть: «Только «${groupTitle}»» открыта`);
const before = sent.e2eRun.length;
// Закрытая кнопка не жмётся: клик ждал бы до таймаута и ронял весь прогон,
// пряча, какая именно проверка покраснела.
if (await onlyGroup.isEnabled()) {
  await onlyGroup.click();
  await card
    .getByRole('button', { name: 'Остановить' })
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
}
check(
  sent.e2eRun.length === before + 1 && sent.e2eRun.at(-1)?.groupId === activeId,
  `прогон группы ушёл с groupId: ${JSON.stringify(sent.e2eRun.at(-1))}`,
);
await shot('e2e-run-own-command');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log('\n| итог | проверка |\n|---|---|');
for (const [verdict, text] of rows) console.log(`| ${verdict} | ${text} |`);
console.log(bad === 0 ? '\nКарточка папки e2e в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
