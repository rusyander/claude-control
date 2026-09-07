/**
 * Прогон ручного прохождения кейсов («Пройти руками»).
 *
 * Проверяется то, ради чего ручной прогон вообще существует: отобранные кейсы
 * превращаются в проходы, панель ведёт по ним по одному, у КАЖДОГО шага своя
 * отметка, заметка про увиденное уходит вместе с результатом, а закрытие
 * прогона возвращает его результат в список кейсов. Отдельно проверяется, что
 * «провален» и «заблокирован» — разные кнопки: смешать их значит потерять
 * разницу между «сломано у нас» и «до шага не дойти».
 *
 * Сервер подменён целиком, включая сессию ручного прогона: настоящая сессия
 * живёт в файлах проверяемого проекта, и на чужой машине её нет. Поэтому здесь
 * же видно, ЧТО именно уходит на сервер, — форма запроса проверяется вместе с
 * интерфейсом.
 *
 * Запуск: `node tools/qa/check-tests-runner.mjs` при поднятом `pnpm dev`.
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

const step = (action, expected) => ({ action, expected });

const CASES = [
  {
    id: 'gui-001',
    type: 'case',
    title: 'Отправка сообщения',
    precondition: 'открыт проект с историей',
    steps: [
      step('открыть чат', 'открылась лента'),
      step('нажать «Отправить»', 'сообщение появилось в ленте'),
    ],
    expected: 'сообщение ушло',
    oracle: 'строка в ленте и запись в транскрипте',
    priority: 'high',
    tags: ['смоук'],
    status: 'unknown',
    source: 'agent',
  },
  {
    id: 'gui-002',
    type: 'case',
    title: 'Пустой ввод не отправляется',
    steps: [step('очистить поле', 'поле пустое'), step('нажать «Отправить»', 'ничего не ушло')],
    expected: 'кнопка выключена',
    priority: 'blocker',
    tags: ['регресс'],
    status: 'unknown',
    source: 'agent',
  },
];

let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [{ id: 'local', title: 'Локальный стенд', isDefault: true }],
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
      cases: CASES.map((item) => ({ ...item })),
    },
  ],
};

/** Открытая сессия ручного прогона — то, что панель держит, пока он идёт. */
let session;
/** Что ушло на старт и на каждую отметку: форма запроса проверяется тоже. */
let startBody;
const posted = [];
let finished = false;

const pointOf = (caseId) => {
  const item = CASES.find((entry) => entry.id === caseId);
  return {
    id: `gui|${caseId}|local`,
    groupId: 'gui',
    caseId,
    title: item?.title ?? caseId,
    environmentId: 'local',
    priority: item?.priority,
    status: 'unknown',
  };
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

/**
 * Порядок регистрации важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
 * обработчику, а `**\/manual*` подходит и к `manual/start`. Поэтому общее
 * чтение сессии идёт первым, а частные записи — после него.
 */
await page.route('**/api/project-tests/manual*', async (route) =>
  route.fulfill({ json: session ? { session } : {} }),
);

await page.route('**/api/project-tests/manual/start*', async (route) => {
  startBody = route.request().postDataJSON();
  const ids = startBody.caseIds?.length ? startBody.caseIds : CASES.map((item) => item.id);
  session = {
    runId: 'manual-1',
    environmentId: startBody.environmentId ?? 'local',
    points: ids.map((id) => pointOf(id)),
    index: 0,
    results: [],
    startedAt: '2026-09-01T10:00:00.000Z',
  };
  return route.fulfill({ json: { session } });
});

await page.route('**/api/project-tests/manual/result*', async (route) => {
  const body = route.request().postDataJSON();
  posted.push(body);
  const results = [
    ...session.results.filter((item) => item.pointId !== body.pointId),
    {
      pointId: body.pointId,
      groupId: 'gui',
      caseId: body.pointId.split('|')[1],
      environmentId: 'local',
      status: body.status,
      note: body.note,
      steps: body.steps,
    },
  ];
  session = { ...session, results, index: Math.min(results.length, session.points.length - 1) };
  // Статус кейса пишется сразу, как это делает сервер: список за спиной
  // прогона обязан быть свежим ещё до его закрытия.
  view = {
    ...view,
    groups: view.groups.map((group) => ({
      ...group,
      cases: group.cases.map((item) =>
        item.id === body.pointId.split('|')[1]
          ? { ...item, status: body.status, note: body.note, lastRunAt: '2026-09-01T10:05:00.000Z' }
          : item,
      ),
    })),
  };
  return route.fulfill({ json: { session } });
});

await page.route('**/api/project-tests/manual/finish*', async (route) => {
  finished = true;
  session = undefined;
  return route.fulfill({ json: {} });
});

await page.route('**/api/project-tests/manual/cancel*', async (route) => {
  session = undefined;
  return route.fulfill({ json: {} });
});

await page.route('**/api/project-tests/run*', async (route) =>
  route.fulfill({ json: { run: undefined } }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/report*', async (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 0, toAutomate: 0, automated: 0 },
      flaky: [],
      totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0 },
    },
  }),
);
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const anyOf = async (scope, names) => {
  for (const name of names) {
    const locator = scope.getByRole('button', { name }).first();
    if ((await locator.count()) > 0) return locator;
  }
  return undefined;
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
  console.log('\nСтраница раздела не открылась — ручной прогон проверить не на чем.');
  await browser.close();
  process.exit(1);
}

const main = page.getByRole('main').or(page.locator('body')).first();

// Отбираем оба кейса и начинаем ручной прогон.
const boxes = main.locator('input[type="checkbox"]');
const boxCount = await boxes.count();
for (let index = 0; index < Math.min(boxCount, 2); index += 1) await boxes.nth(index).check();
await page.waitForTimeout(400);

const startButton = await anyOf(main, [/Пройти руками/, /Ручной прогон/, /Пройти вручную/]);
if (!startButton) {
  check(false, 'на странице есть запуск ручного прогона');
  console.log('\nЗапуск ручного прогона не найден — остальные проверки не выполнялись.');
  await browser.close();
  process.exit(1);
}
await startButton.click();
await page.waitForTimeout(1500);

check(Boolean(startBody), 'старт ручного прогона ушёл на сервер');
check(startBody?.path === PROJECT.path, 'прогон адресован открытому проекту');
check(startBody?.caseIds?.length === 2, `на старт ушли отмеченные кейсы: ${startBody?.caseIds}`);

const runner = page.getByRole('dialog').last().or(main).first();

check(
  (await runner.getByText(/1\s*(из|\/)\s*2/).count()) > 0,
  'видно, какой проход идёт и сколько всего',
);
check((await runner.getByText('Отправка сообщения').count()) > 0, 'открыт первый отобранный кейс');
check(
  (await runner.getByText('открылась лента').count()) > 0,
  'у шага показано его ожидание — по нему и ставят отметку',
);
check(
  (await runner.getByText(/открыт проект с историей/).count()) > 0,
  'предусловие кейса показано до шагов',
);

// Отметка по шагам: у каждого шага своя, иначе провал не объяснить.
const stepMarks = runner.getByRole('button', { name: /^(Прошёл|Провален|Пройден|Провалён)$/ });
const stepMarkCount = await stepMarks.count();
check(stepMarkCount >= 2, `у шагов есть свои отметки: кнопок ${stepMarkCount}`);

// Заметка про увиденное и итог прохода.
const note = runner.getByRole('textbox').last();
if ((await note.count()) > 0) await note.fill('кнопка осталась активной');
await page.waitForTimeout(300);

const failButton = await anyOf(runner, [/^Провален$/, /^Провалён$/, /Не прошёл/]);
if (!failButton) {
  check(false, 'есть кнопка «Провален»');
} else {
  await failButton.click();
  await page.waitForTimeout(1200);
  const first = posted.at(-1);
  check(first?.status === 'failed', `итог прохода ушёл провалом: ${first?.status}`);
  check(first?.note === 'кнопка осталась активной', 'заметка про увиденное ушла вместе с итогом');
  check(first?.runId === 'manual-1', 'отметка адресована открытой сессии');
}

check(
  (await runner.getByText('Пустой ввод не отправляется').count()) > 0,
  'после отметки панель сама переходит к следующему проходу',
);
check((await runner.getByText(/2\s*(из|\/)\s*2/).count()) > 0, 'счётчик проходов сдвинулся');

// Заблокирован — отдельная кнопка, а не разновидность провала.
check(
  (await runner.getByRole('button', { name: /Заблокирован/ }).count()) > 0,
  '«заблокирован» отделён от провала',
);

const passButton = await anyOf(runner, [/^Прошёл$/, /^Пройден$/, /^Прошел$/]);
if (passButton) {
  await passButton.click();
  await page.waitForTimeout(1200);
  check(posted.at(-1)?.status === 'passed', 'второй проход ушёл пройденным');
}

const finishButton = await anyOf(runner, [/Закончить/, /Завершить/]);
if (!finishButton) {
  check(false, 'прогон можно закончить');
} else {
  await finishButton.click();
  await page.waitForTimeout(1500);
  check(finished, 'закрытие прогона ушло на сервер');
}

// Результат вернулся в список: провал виден и объяснён.
await page.waitForTimeout(1200);
check(
  (await main.getByText('кнопка осталась активной').count()) > 0 ||
    (await main.getByText(/провален/i).count()) > 0,
  'результат ручного прогона виден в списке кейсов',
);

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nРучной прогон в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
