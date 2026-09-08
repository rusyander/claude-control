/**
 * Управляемая генерация: черновик, приёмка и откат.
 *
 * Проверяется то, ради чего черновик и заведён: прогон генерации НЕ меняет
 * библиотеку сам — он оставляет предложение, и человек видит его списком, а не
 * `git diff`. Отдельно проверяется, что похожий кейс назван прямо в приёмке
 * (без этого третья генерация подряд кладёт в набор третий «Вход с пустым
 * паролем»), что галочка «принимать сразу» уходит на сервер как решение о
 * проекте и что принятое можно отменить одной кнопкой.
 *
 * Сервер подменён целиком: черновики живут в файлах проверяемого проекта, и на
 * чужой машине их нет. Заодно видно, ЧТО именно уходит на сервер — форма
 * запроса проверяется вместе с интерфейсом.
 *
 * Запуск: `node tools/qa/check-tests-generate.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };
const RUN_ID = 'gen-0001';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
const step = (action, expected) => ({ action, expected });

/** Кейс, который в библиотеке УЖЕ есть, — на него и будет похоже предложение. */
const EXISTING = {
  id: 'gui-014',
  type: 'case',
  title: 'Вход с пустым паролем',
  steps: [step('оставить пароль пустым', 'кнопка выключена')],
  status: 'unknown',
  source: 'agent',
};

const PROPOSED = [
  {
    op: 'add',
    groupId: 'gui',
    caseId: 'gui-101',
    testCase: {
      id: 'gui-101',
      type: 'case',
      title: 'Вход без пароля',
      steps: [step('очистить поле пароля', 'форма не отправляется')],
      oracle: 'сообщение об ошибке под полем',
      priority: 'high',
      status: 'unknown',
      source: 'agent',
    },
    reason: 'негативная проверка формы входа',
    similarTo: [{ groupId: 'gui', caseId: 'gui-014', title: EXISTING.title, score: 0.82 }],
    state: 'pending',
  },
  {
    op: 'add',
    groupId: 'gui',
    caseId: 'gui-102',
    testCase: {
      id: 'gui-102',
      type: 'case',
      title: 'Выход из учётной записи',
      steps: [step('нажать «Выйти»', 'открылась форма входа')],
      oracle: 'форма входа на экране',
      priority: 'medium',
      status: 'unknown',
      source: 'agent',
    },
    reason: 'ежедневный сценарий, кейса на него нет',
    state: 'pending',
  },
];

/** Черновик на сервере: приёмка меняет ЕГО, а не только список кейсов. */
let draft = {
  version: 1,
  runId: RUN_ID,
  source: 'code',
  createdAt: '2026-09-08T10:00:00.000Z',
  file: `.agent/tests/drafts/${RUN_ID}.draft.json`,
  status: 'pending',
  items: PROPOSED.map((item) => ({ ...item })),
};

const summarize = () => ({
  runId: draft.runId,
  createdAt: draft.createdAt,
  source: draft.source,
  status: draft.status,
  file: draft.file,
  total: draft.items.length,
  pending: draft.items.filter((item) => (item.state ?? 'pending') === 'pending').length,
  accepted: draft.items.filter((item) => item.state === 'accepted').length,
  rejected: draft.items.filter((item) => item.state === 'rejected').length,
  auto: draft.auto,
});

let autoAccept = false;
let cases = [{ ...EXISTING }];

const buildView = () => ({
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  drafts: [summarize()],
  autoAcceptDrafts: autoAccept,
  branch: 'qa/branch',
  commit: 'abcdef1234567890',
  groups: [
    {
      id: 'gui',
      title: 'GUI',
      file: '.agent/tests/gui.tests.json',
      cases: cases.map((item) => ({ ...item })),
    },
  ],
});

/** Что ушло на сервер — форма запроса проверяется наравне с экраном. */
let applyBody;
let autoBody;
let rollbackBody;
let runBody;

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
 * Порядок регистрации важен вдвойне: подходящий обработчик Playwright берёт
 * ПОСЛЕДНИЙ, а `run*` подходит и к `/runs`. Поэтому запуск идёт первым, а всё,
 * что длиннее, — после него.
 */
await page.route('**/api/project-tests/run*', async (route) => {
  if (route.request().method() !== 'POST') return route.fulfill({ json: { run: undefined } });
  runBody = route.request().postDataJSON();
  return route.fulfill({ json: buildView() });
});

await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
// Здоровье набора и карантин живут на вкладке отчёта: без заглушек оба маршрута
// отвечают 400 на несуществующий проект, и «ошибок в консоли нет» краснеет не о
// том.
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 0,
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
await page.route('**/api/project-tests/risk*', async (route) =>
  route.fulfill({ json: { items: [], checkedAt: '2026-09-08T10:00:00.000Z' } }),
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
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));

await page.route('**/api/project-tests/drafts*', async (route) =>
  route.fulfill({ json: { drafts: [draft], autoAccept } }),
);

await page.route('**/api/project-tests/draft/apply*', async (route) => {
  applyBody = route.request().postDataJSON();
  if (applyBody.auto) autoAccept = true;
  const wanted = applyBody.caseIds?.length ? applyBody.caseIds : null;
  const items = draft.items.map((item) =>
    (item.state ?? 'pending') === 'pending' && (!wanted || wanted.includes(item.caseId))
      ? { ...item, state: 'accepted', appliedAt: '2026-09-08T11:00:00.000Z' }
      : item,
  );
  const applied = items.filter(
    (item, index) => item.state === 'accepted' && draft.items[index].state !== 'accepted',
  );
  cases = [...cases, ...applied.map((item) => ({ ...item.testCase, readiness: 'draft' }))];
  draft = {
    ...draft,
    items,
    auto: applyBody.auto ? true : draft.auto,
    status: items.some((item) => (item.state ?? 'pending') === 'pending') ? 'pending' : 'applied',
  };
  return route.fulfill({
    json: { applied: applied.length, skipped: [], draft, view: buildView() },
  });
});

await page.route('**/api/project-tests/draft/rollback*', async (route) => {
  rollbackBody = route.request().postDataJSON();
  const removed = draft.items.filter((item) => item.state === 'accepted');
  cases = cases.filter((item) => !removed.some((entry) => entry.caseId === item.id));
  draft = {
    ...draft,
    items: draft.items.map((item) =>
      item.state === 'accepted' ? { ...item, state: 'rolledBack' } : item,
    ),
    status: 'rolledBack',
  };
  return route.fulfill({
    json: {
      removed: removed.length,
      restored: 0,
      kept: [],
      draft,
      view: buildView(),
    },
  });
});

await page.route('**/api/project-tests/draft/reject*', async (route) => {
  draft = { ...draft, status: 'rejected', items: [] };
  return route.fulfill({ json: { draft, view: buildView() } });
});

await page.route('**/api/project-tests/draft/auto*', async (route) => {
  autoBody = route.request().postDataJSON();
  autoAccept = autoBody.enabled === true;
  return route.fulfill({ json: { autoAccept, view: buildView() } });
});

await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: buildView() }));

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
  console.log('\nСтраница раздела не открылась — приёмку проверить не на чем.');
  await browser.close();
  process.exit(1);
}

const main = page.getByRole('main').or(page.locator('body')).first();

// Черновик ждёт — и об этом сказано во вкладке, а не только в файле.
check(
  (await main.getByText(/предложила правок/i).count()) > 0,
  'плашка называет, сколько правок ждут решения',
);
// Библиотека до приёмки не изменилась: предложенных кейсов в списке нет.
check(
  (await main.getByText('Вход без пароля').count()) === 0,
  'до приёмки предложенного кейса в библиотеке нет',
);

const openButton = await anyOf(main, [/Посмотреть/]);
if (!openButton) {
  check(false, 'плашка открывает приёмку');
  console.log('\nКнопка приёмки не найдена — остальные проверки не выполнялись.');
  await browser.close();
  process.exit(1);
}
await openButton.click();
await page.waitForTimeout(1200);

const modal = page.getByRole('dialog').last();
check((await modal.getByText('Вход без пароля').count()) > 0, 'предложение видно в приёмке');
check(
  (await modal.getByText(/похоже на gui-014/i).count()) > 0,
  'похожий кейс назван прямо в приёмке — иначе дубли копятся молча',
);
check(
  (await modal.getByText(/негативная проверка формы входа/).count()) > 0,
  'видно, зачем агент предложил этот кейс',
);
check(
  (await modal.getByText(new RegExp(RUN_ID)).count()) > 0,
  'назван файл черновика — его можно открыть руками',
);

// Берём ОДНО предложение из двух: выборочная приёмка и есть смысл окна —
// иначе оно было бы кнопкой «применить» на плашке.
const pick = modal.getByRole('switch', { name: /Отметить «Вход без пароля»/ }).first();
if ((await pick.count()) === 0) {
  check(false, 'предложение можно отметить по одному');
} else {
  await pick.click();
  await page.waitForTimeout(400);
  check(
    (await modal.getByRole('button', { name: /Принять отмеченные \(1\)/ }).count()) > 0,
    'кнопка называет, сколько отмечено',
  );
  await modal.getByRole('button', { name: /Принять отмеченные \(1\)/ }).click();
  await page.waitForTimeout(1500);
  check(applyBody?.runId === RUN_ID, 'приёмка адресована прогону-автору');
  check(applyBody?.path === PROJECT.path, 'приёмка адресована открытому проекту');
  check(
    JSON.stringify(applyBody?.caseIds) === JSON.stringify(['gui-101']),
    'на сервер ушёл ровно отмеченный кейс',
  );
  check(applyBody?.auto !== true, 'обычная приёмка не включает автоприём молча');
  check((await modal.getByText(/Принято кейсов: 1/).count()) > 0, 'сказано, сколько принято');
  check(
    (await modal.getByText('Вход без пароля').count()) === 0,
    'принятое ушло из списка ожидающих',
  );
  check(
    (await modal.getByRole('button', { name: /Принять отмеченные/ }).count()) === 0,
    'отметки снялись — кнопка не обещает принять уже принятое',
  );
}

// Принятое обязано оказаться в самой библиотеке, а не только в окне приёмки:
// ради этого перехода черновик и заведён.
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
check((await main.getByText('Вход без пароля').count()) > 0, 'принятый кейс виден в библиотеке');
check(
  (await main.getByText(/предложила правок: 1/i).count()) > 0,
  'плашка пересчитала остаток предложений',
);
const reopen = await anyOf(main, [/Посмотреть/]);
if (reopen) {
  await reopen.click();
  await page.waitForTimeout(1200);
}

// Принимаем остаток: библиотека меняется ПАНЕЛЬЮ, а не прогоном.
const applyAll = await anyOf(modal, [/Принять всё/]);
if (!applyAll) {
  check(false, 'в приёмке есть кнопка «Принять всё»');
} else {
  await applyAll.click();
  await page.waitForTimeout(1500);
  check(applyBody?.caseIds === undefined, 'приёмка остатка идёт без перечисления кейсов');
  check(
    (await modal.getByText(/Все предложения этого черновика уже приняты/).count()) > 0,
    'разобранный черновик так и говорит',
  );
}

// И отменяем: принятое обязано откатываться одной кнопкой.
const undo = await anyOf(modal, [/Отменить приёмку/]);
if (!undo) {
  check(false, 'принятое можно отменить');
} else {
  await undo.click();
  await page.waitForTimeout(1500);
  check(rollbackBody?.runId === RUN_ID, 'откат адресован тому же прогону');
  check((await modal.getByText(/Убрано кейсов: 2/).count()) > 0, 'откат отчитался, что убрал');
}

await page.keyboard.press('Escape');
await page.waitForTimeout(900);
check(
  (await main.getByText('Вход без пароля').count()) === 0,
  'откат убрал кейс и из библиотеки, а не только из черновика',
);

// Галочка «принимать сразу» — решение о проекте, и оно уходит на сервер.
const toggle = main.getByRole('switch', { name: /Принимать сразу/i }).first();
if ((await toggle.count()) === 0) {
  check(false, 'в пульте есть галочка «принимать сразу»');
} else {
  check((await toggle.getAttribute('aria-checked')) === 'false', 'галочка по умолчанию выключена');
  await toggle.click();
  await page.waitForTimeout(1200);
  check(autoBody?.enabled === true, 'включение галочки ушло на сервер');
  check(autoBody?.path === PROJECT.path, 'галочка запоминается на открытый проект');
}

// И запуск генерации несёт её с собой — прогон должен знать, чем кончится.
const generate = await anyOf(main, [/^Сгенерировать/, /Сгенерировать кейсы/, /Генерация/]);
if (!generate) {
  check(false, 'в пульте есть запуск генерации');
} else {
  await generate.click();
  await page.waitForTimeout(1200);
  check(runBody?.mode === 'generate', 'запустилась именно генерация');
  check(runBody?.autoAccept === true, 'положение галочки уехало вместе с запуском');
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nПриёмка черновиков в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
