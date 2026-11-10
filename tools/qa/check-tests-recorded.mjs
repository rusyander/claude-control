/**
 * Вкладка «Сценарии» раздела «Тесты» (этап 12, R3–R4, 08d P179–P180) — живой фронт `pnpm dev`,
 * ответы сервера и ядра подменены `page.route` на границе сети: проверяемый проект живёт только в
 * этом сквозняке, реестр стенда, файлы на диске и настоящее ядро не трогаются. Что делает сервер
 * на настоящем проекте (спек на диске, `tests-cli run --max-failures 1`, настоящий Chromium по
 * стенду-фикстуре, модель-заглушка без единого вызова) — `recorded.integration.test.ts` и
 * `recorded-routes.integration.test.ts`; здесь — что человек видит и что уходит по его нажатию.
 *
 * Что видно:
 *   - пусто — так и сказано, «Прогнать все» заперта (гнать нечего);
 *   - «Записать сценарий»: пустая цель — кнопка заперта; медленный запуск — кнопка занята; строки
 *     прохода приходят по мере хода (счёт шагов), после конца — имя и группа; тело записи несёт
 *     строки прохода как есть, группу `scenarios`, задачу; ответ — файл спека и «не проверено»;
 *   - проход без единого удавшегося шага — причина словами, кнопки записи нет;
 *   - отказ записи (кейс написан человеком, 409) — текст сервера в окне, а не код;
 *   - список: полоска из 20 отметок, «не записано», ссылка на задачу прохода;
 *   - «Прогнать все»: окружение уходит в тело; пока идёт — кнопка занята и строка «Идёт»; встал —
 *     карточка расхождения с шагом и ОДНОЙ задачей прохода;
 *   - «Сценарий устарел» → тело `stale`; перезапись заперта, пока проход идёт, после — `POST
 *     /recorded` с `caseId` упавшего кейса; «Дефект продукта» → тело `defect`, перезаписи нет.
 *
 * Запуск: `node tools/qa/check-tests-recorded.mjs` при поднятом `pnpm dev` (`APP_URL` — другой
 * фронт). `SHOTS=<dir>` — кадры в обеих темах (`SHOT_TAG`, по умолчанию AFTER). Код выхода: 0 —
 * сходится, 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { installTestsRunStub, TESTS_PROJECT } from './check-core-inbox.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
const TAG = process.env.SHOT_TAG ?? 'AFTER';
const NOW = '2026-11-09T10:00:00.000Z';

const step = (n, ok, kind = 'click') => ({
  stepId: `0190a000-0000-7000-8000-00000000000${n}`,
  kind,
  ok,
});

/** Записанный кейс списка; `marks` — полоска прогонов, новые первыми. */
const recordedCase = (caseId, title, marks, extra = {}) => ({
  groupId: 'scenarios',
  caseId,
  title,
  file: `.agent/tests/recorded/scenarios/${caseId}.recorded.mjs`,
  testName: `recorded > ${title}`,
  taskId: `task-${caseId}`,
  unchecked: 0,
  status: marks[0] ?? 'unknown',
  history: marks.map((status, index) => ({
    runId: `run-${caseId}-${index}`,
    startedAt: new Date(Date.parse(NOW) - index * 3_600_000).toISOString(),
    status,
  })),
  ...extra,
});

export const RECORDED_FILLED = [
  recordedCase(
    'scenarios-001',
    'Вход на стенд',
    ['passed', ...Array.from({ length: 19 }, (_, i) => (i === 6 ? 'failed' : 'passed'))],
    { unchecked: 2 },
  ),
  recordedCase('scenarios-002', 'Выход со стенда', ['passed', 'passed']),
];

export const RECORDED_MISMATCH = {
  status: 'mismatch',
  startedAt: NOW,
  finishedAt: NOW,
  environmentId: 'qa',
  total: 2,
  runId: 'run-qa-1',
  mismatch: {
    groupId: 'scenarios',
    caseId: 'scenarios-001',
    title: 'Вход на стенд',
    step: { n: 5, title: 'в элемент data-testid «greeting» текст «Привет, demo»' },
    message: '✗ шаг 5: в элемент data-testid «greeting» текст «Привет, demo»',
    taskId: 'walk-mismatch',
  },
};

/**
 * Подмена раздела «Тесты» с вкладкой «Сценарии». `state` — живые ответы: что отдаёт список,
 * как отвечают проход, запись, прогон и решение; `sent` — тела, ушедшие по нажатию.
 */
export async function installRecordedStub(page, initial = {}) {
  const state = {
    cases: [],
    replay: undefined,
    walks: {},
    walkDelayMs: 0,
    recordRefusal: undefined,
    replayGets: 0,
    ...initial,
  };
  const sent = { walk: [], record: [], replay: [], verdict: [] };
  await installTestsRunStub(page);
  await page.route('**/api/project-tests?*', (route) =>
    route.fulfill({
      json: {
        projectPath: TESTS_PROJECT.path,
        dir: '.agent/tests',
        hasConvention: true,
        sharedSteps: [],
        environments: [
          { id: 'local', title: 'Локально', isDefault: true },
          { id: 'qa', title: 'QA-стенд' },
        ],
        schema: { attributes: [], statuses: [] },
        views: [],
        plans: [],
        branch: 'main',
        groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: [] }],
      },
    }),
  );
  await page.route('**/api/project-tests/recorded*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      sent.record.push(body);
      if (state.recordRefusal) {
        return route.fulfill({ status: 409, json: { message: state.recordRefusal } });
      }
      const caseId = body.caseId ?? `scenarios-00${state.cases.length + 1}`;
      return route.fulfill({
        json: {
          groupId: body.groupId,
          caseId,
          file: `.agent/tests/recorded/${body.groupId}/${caseId}.recorded.mjs`,
          testName: `recorded > ${body.title}`,
          created: !body.caseId,
          unchecked: body.gaps.length,
        },
      });
    }
    // «Идёт» держится два чтения, затем прогон встаёт на расхождении — как фоновый сервер.
    if (state.replay?.status === 'running') {
      state.replayGets += 1;
      if (state.replayGets > 2) state.replay = { ...RECORDED_MISMATCH };
    }
    return route.fulfill({ json: { cases: state.cases, replay: state.replay } });
  });
  await page.route('**/api/project-tests/recorded/walk*', async (route) => {
    sent.walk.push(route.request().postDataJSON());
    if (state.walkDelayMs) await new Promise((done) => setTimeout(done, state.walkDelayMs));
    return route.fulfill({ json: { taskId: state.nextWalk ?? 'walk-qa-1' } });
  });
  await page.route('**/api/project-tests/recorded/replay*', (route) => {
    sent.replay.push(route.request().postDataJSON());
    state.replayGets = 0;
    state.replay = { status: 'running', startedAt: NOW, total: state.cases.length };
    return route.fulfill({ json: state.replay });
  });
  await page.route('**/api/project-tests/recorded/verdict*', (route) => {
    const body = route.request().postDataJSON();
    sent.verdict.push(body);
    state.replay = {
      ...state.replay,
      mismatch: { ...state.replay.mismatch, verdict: body.verdict },
    };
    return route.fulfill({ json: state.replay });
  });
  await page.route('**/api/core/tasks/*/walk*', (route) => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
    const plan = state.walks[taskId] ?? [];
    // Каждое чтение — следующий кадр прохода; последний повторяется.
    const frame = plan.length > 1 ? plan.shift() : plan[0];
    return route.fulfill({ json: { taskId, steps: [], gaps: [], ended: false, ...frame } });
  });
  await page.evaluate((project) => {
    const id = project.path.toLowerCase();
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id, path: project.path, name: project.name }],
        activeTabId: id,
        views: {},
      }),
    );
    localStorage.setItem('agentdeck:tests-project', id);
  }, TESTS_PROJECT);
  return { state, sent };
}

/** Подмена для обходов доступности и клавиатуры: список и карточка расхождения. */
export async function stubRecordedFilled(page) {
  await installRecordedStub(page, { cases: RECORDED_FILLED, replay: { ...RECORDED_MISMATCH } });
}

let bad = 0;
const rows = [];
const check = (text, ok, detail = '') => {
  if (!ok) bad += 1;
  rows.push({ check: text, verdict: ok ? 'ok' : 'FAIL', detail: ok ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `\n      ${detail}` : ''}`);
  return ok;
};

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

const settle = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    // Отказ 409 подстроен сценарием: браузер пишет о нём сам, это не ошибка страницы.
    if (message.type() === 'error' && !/status of 409/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await bypassOnboarding(page);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const { state, sent } = await installRecordedStub(page);
  await page.goto(`${BASE}/tests?tab=recorded`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page
    .getByRole('button', { name: 'Сценарии', exact: true })
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  await shoot(page, 'tabs');

  console.log('Пусто');
  check(
    'вкладка «Сценарии» есть в строке вкладок',
    (await page.getByRole('button', { name: 'Сценарии', exact: true }).count()) === 1,
  );
  const empty = page.getByText('Проходов по стенду пока нет.');
  await empty.waitFor().catch(() => undefined);
  check('пустой список сказан словами', await empty.isVisible().catch(() => false));
  const replayButton = page.getByRole('button', { name: 'Прогнать все' });
  check('«Прогнать все» заперта, пока сценариев нет', await replayButton.isDisabled());

  console.log('Запись прохода');
  state.walkDelayMs = 900;
  state.walks['walk-qa-1'] = [
    { steps: [step(1, true, 'open')] },
    { steps: [step(1, true, 'open'), step(2, true, 'fill'), step(3, false)] },
    {
      steps: [step(1, true, 'open'), step(2, true, 'fill'), step(3, true)],
      gaps: [{ at: step(3, true).stepId, reason: 'капча' }],
      ended: true,
    },
  ];
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  const modal = page.getByRole('dialog');
  const start = modal.getByRole('button', { name: 'Начать проход' });
  check('пустая цель: «Начать проход» заперта', await start.isDisabled());
  await modal.getByLabel('Что пройти на стенде').fill('войти под demo и увидеть приветствие');
  await modal
    .getByLabel('Окружение')
    .selectOption('qa')
    .catch(() => undefined);
  await start.click();
  await settle(200);
  check(
    'медленный запуск: кнопка занята («Запускаем проход…»)',
    (await modal.getByRole('button', { name: /Запускаем проход/ }).count()) === 1,
  );
  const walking = modal.getByText(/Ядро проходит стенд: шагов \d+/);
  await walking.waitFor().catch(() => undefined);
  check('пока проход идёт — счёт шагов', await walking.isVisible().catch(() => false));
  check(
    'цель и окружение ушли в тело запуска',
    sent.walk[0]?.goal === 'войти под demo и увидеть приветствие' &&
      sent.walk[0]?.environmentId === 'qa',
    JSON.stringify(sent.walk[0]),
  );
  // Окно закрыли посреди прохода, потом перечитали страницу: проход платный и идёт в ядре — окно
  // снова показывает его, а не пустую цель (иначе записать его в кейс уже нечем).
  await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  check(
    'закрыли посреди прохода — окно снова показывает проход, а не пустую цель',
    (await modal.getByLabel('Что пройти на стенде').count()) === 0 &&
      (await modal
        .getByText(/Ядро проходит стенд|Проход кончился/)
        .first()
        .isVisible()
        .catch(() => false)),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  check(
    'и после перечитки страницы проход тот же',
    (await modal.getByLabel('Что пройти на стенде').count()) === 0 &&
      (await modal
        .getByRole('link', { name: 'Открыть задачу' })
        .isVisible()
        .catch(() => false)),
  );
  check(
    'пока проход не записан — есть «Новый проход», чтобы начать другой',
    (await modal.getByRole('button', { name: 'Новый проход' }).count()) === 1,
  );
  const ended = modal.getByText('Проход кончился: шагов 3, удавшихся 3, пробелов 1');
  await ended.waitFor({ timeout: 10_000 }).catch(() => undefined);
  check('проход кончился — итог словами', await ended.isVisible().catch(() => false));
  const save = modal.getByRole('button', { name: 'Записать в кейс и спек' });
  check('без имени запись заперта', await save.isDisabled().catch(() => false));
  await modal.getByLabel('Название сценария').fill('Вход на стенд');
  await shoot(page, 'record-modal');
  await save.click();
  const saved = modal.getByText(/Записано: \.agent\/tests\/recorded\/scenarios\//);
  await saved.waitFor().catch(() => undefined);
  check('ответ записи — файл спека', await saved.isVisible().catch(() => false));
  check(
    'пробел прохода назван «не проверено»',
    (await modal.getByText('Шагов «не проверено»: 1', { exact: false }).count()) === 1,
  );
  const body = sent.record[0];
  check(
    'тело записи — строки прохода как есть, группа scenarios, задача',
    body?.groupId === 'scenarios' &&
      body?.title === 'Вход на стенд' &&
      body?.taskId === 'walk-qa-1' &&
      body?.steps?.length === 3 &&
      body?.gaps?.length === 1 &&
      body?.caseId === undefined,
    JSON.stringify(body),
  );
  await modal.getByRole('button', { name: 'Готово', exact: true }).click();

  console.log('Проход без удавшегося шага');
  state.walkDelayMs = 0;
  state.nextWalk = 'walk-qa-2';
  state.walks['walk-qa-2'] = [{ steps: [step(1, false, 'open')], ended: true }];
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  await modal.getByLabel('Что пройти на стенде').fill('открыть закрытую страницу');
  await modal.getByRole('button', { name: 'Начать проход' }).click();
  const noPassed = modal.getByText('В проходе нет ни одного удавшегося шага');
  await noPassed.waitFor().catch(() => undefined);
  check('ни одного удавшегося — причина словами', await noPassed.isVisible().catch(() => false));
  check(
    'и кнопки записи нет',
    (await modal.getByRole('button', { name: 'Записать в кейс и спек' }).count()) === 0,
  );
  await modal.getByRole('button', { name: 'Отмена' }).click();

  console.log('Отказ записи');
  state.nextWalk = 'walk-qa-3';
  state.walks['walk-qa-3'] = [{ steps: [step(1, true, 'open')], ended: true }];
  state.recordRefusal = 'Кейс написан человеком — запись прохода его не перезапишет.';
  await page.getByRole('button', { name: 'Записать сценарий' }).click();
  await modal.getByLabel('Что пройти на стенде').fill('войти');
  await modal.getByRole('button', { name: 'Начать проход' }).click();
  await modal.getByLabel('Название сценария').fill('Ручной вход');
  await modal.getByRole('button', { name: 'Записать в кейс и спек' }).click();
  const refusal = modal.getByRole('alert').filter({ hasText: 'Кейс написан человеком' });
  await refusal.waitFor().catch(() => undefined);
  check(
    '409 — текст сервера в окне',
    await refusal.isVisible().catch(() => false),
    (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400),
  );
  await settle(600);
  const copies = await page.getByText('Кейс написан человеком', { exact: false }).count();
  check('отказ сказан один раз — в окне, без копии общим тостом', copies === 1, `копий ${copies}`);
  await modal.getByRole('button', { name: 'Отмена' }).click();
  state.recordRefusal = undefined;

  console.log('Список');
  state.cases = RECORDED_FILLED;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const firstRow = page.getByTestId('recorded-case').first();
  await firstRow.waitFor().catch(() => undefined);
  check(
    'полоска — 20 отметок',
    (await firstRow.getByRole('list', { name: 'Последние прогоны: 20' }).locator('li').count()) ===
      20,
  );
  check(
    '«не записано» у кейса с пробелами',
    (await firstRow.getByText('Не записано: 2').count()) === 1,
  );
  check(
    'ссылка на задачу прохода',
    (await firstRow.getByRole('link', { name: 'Задача прохода' }).getAttribute('href'))?.includes(
      'id=task-scenarios-001',
    ) === true,
  );
  await shoot(page, 'list');

  console.log('Прогнать все');
  await page.getByLabel('Окружение прогона').selectOption('qa');
  await replayButton.click();
  await settle(150);
  check('пока идёт — кнопка занята', await replayButton.isDisabled());
  const runningLine = page.getByTestId('recorded-replay-state');
  check(
    'строка «Идёт прогон»',
    /Идёт прогон записанных сценариев: 2/.test((await runningLine.textContent()) ?? ''),
  );
  check(
    'окружение ушло в тело прогона',
    sent.replay[0]?.environmentId === 'qa' && sent.replay[0]?.path === TESTS_PROJECT.path,
    JSON.stringify(sent.replay[0]),
  );
  const card = page.getByTestId('recorded-mismatch');
  await card.waitFor({ timeout: 10_000 }).catch(() => undefined);
  check('встал — карточка расхождения', await card.isVisible().catch(() => false));
  check(
    'карточка называет шаг',
    (await card
      .getByText('Шаг 5: в элемент data-testid «greeting» текст «Привет, demo»', { exact: true })
      .count()) === 1,
  );
  check(
    'одна задача прохода — ссылка',
    (await card.getByRole('link').count()) === 1 &&
      (await card.getByRole('link').getAttribute('href'))?.includes('id=walk-mismatch') === true,
  );
  await shoot(page, 'mismatch');

  console.log('Сценарий устарел');
  state.walks['walk-mismatch'] = [
    { steps: [step(1, true, 'open')] },
    { steps: [step(1, true, 'open')] },
    { steps: [step(1, true, 'open'), step(2, true)], ended: true },
  ];
  await card.getByRole('button', { name: 'Сценарий устарел' }).click();
  await card
    .getByText('Отмечено: сценарий устарел')
    .waitFor()
    .catch(() => undefined);
  check('тело решения — stale', sent.verdict[0]?.verdict === 'stale', JSON.stringify(sent.verdict));
  const rerecord = card.getByRole('button', { name: 'Перезаписать из прохода' });
  check('пока проход идёт — перезапись заперта', await rerecord.isDisabled().catch(() => false));
  await rerecord.waitFor({ state: 'visible' });
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('[data-testid="recorded-mismatch"] button')].some(
          (b) => b.textContent?.includes('Перезаписать') && b.disabled,
        ),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await rerecord.click().catch(() => undefined);
  await card
    .getByText(/Сценарий перезаписан/)
    .waitFor()
    .catch(() => undefined);
  const again = sent.record.at(-1);
  check(
    'перезапись — тот же кейс, строки нового прохода',
    again?.caseId === 'scenarios-001' &&
      again?.taskId === 'walk-mismatch' &&
      again?.steps?.length === 2,
    JSON.stringify(again),
  );

  console.log('Дефект продукта');
  state.replay = { ...RECORDED_MISMATCH };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await card.waitFor().catch(() => undefined);
  await card.getByRole('button', { name: 'Дефект продукта' }).click();
  await card
    .getByText('Отмечено: дефект продукта')
    .waitFor()
    .catch(() => undefined);
  check('тело решения — defect', sent.verdict.at(-1)?.verdict === 'defect');
  check(
    'после дефекта перезаписи нет',
    (await card.getByRole('button', { name: 'Перезаписать из прохода' }).count()) === 0,
  );

  check('ошибок страницы нет', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n| проверка | итог | подробно |\n|---|---|---|');
  for (const row of rows) console.log(`| ${row.check} | ${row.verdict} | ${row.detail} |`);
  console.log(bad === 0 ? '\nВкладка «Сценарии» в порядке.' : `\nПроблем: ${bad}`);
  await browser.close();
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
