/**
 * Входящие доски из трекера (этап 12, I7, D16, P167, P183) — живой фронт `pnpm dev`, ответы ядра
 * подменены `page.route` на границе сети прокладки: настройка (`GET|POST /api/core/config`), поиск
 * (`GET /api/core/inbox/search`), заведение (`POST /api/core/inbox`), записи доски
 * (`POST /api/core/board/entries`) и сама доска (`installCoreBoardStub`). Тела, ушедшие в ядро,
 * судятся схемами контрактов — подмена, разошедшаяся с ядром, падает здесь. Живой путь «ядро ↔
 * stub-tracker» идёт в закрывающем проходе волны: там эти же ручки отвечает настоящее ядро.
 *
 * Что видно:
 *   - над доской строка «Входящие из трекера»: источников нет → так и сказано; после записи — их счёт;
 *   - «Источники»: Jira и GitLab добавляются, GitHub виден и выбрать его нельзя («не поддерживается»);
 *     новый источник — «Сам в очередь» ВЫКЛЮЧЕН; запись уходит `POST /config` целым документом с
 *     отпечатком и разделом `inbox`; плохое имя и занятое имя — причина, кнопка «Сохранить» заперта;
 *     ядро ответило 409 (настройку правили) — его причина и «Перечитать», молча ничего не пишется;
 *   - «Найти в трекере»: запрос уходит только в `GET /inbox/search` (ни в одно другое тело — P167),
 *     пока ответа нет — «Ищу…», не «Ничего не нашлось»; выбор двух из трёх — ОДИН `POST /inbox` с
 *     двумя тикетами, ответ ядра «новых 2»; «неизвестно» источника — причиной, обрезка — подписью;
 *   - «Тесты» → прогон → красный кейс «На доску»: запись `tests` во «Входящие» с полями оценки
 *     (разбор провала, репозиторий проекта), у зелёного и заблокированного кнопки нет; отказ ядра —
 *     причиной.
 *
 * Запуск: `node tools/qa/check-core-inbox.mjs` при поднятом `pnpm dev` (`APP_URL` — другой фронт).
 * `SHOTS=<dir>` — кадры в обеих темах (`SHOT_TAG`, по умолчанию AFTER). Код выхода: 0 — сходится,
 * 1 — провал.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { BOARD_IDS, installCoreBoardStub } from './check-core-board.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = (file) => import(pathToFileURL(join(ROOT, 'packages/contracts/src', file)).href);
const { setConfigBodySchema } = await contract('core/config.ts');
const { inboxCreateBodySchema, inboxItemSchema } = await contract('core/inbox.ts');
const { boardEntriesBodySchema, boardMoveBodySchema } = await contract('core/panel-api.ts');

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

/** Свой запрос человека: его текст не должен появиться ни в одном теле, кроме поиска. */
export const INBOX_JQL = 'project = PROJ AND labels = qa-inbox ORDER BY created DESC';
const sha = (text) => createHash('sha256').update(text).digest('hex');

function item(n, patch = {}) {
  return inboxItemSchema.parse({
    sourceId: 'jira',
    system: 'jira',
    key: `PROJ-${n}`,
    kind: 'issue',
    title: `Тикет ${n}: проверить вход`,
    url: `https://tracker.example.com/browse/PROJ-${n}`,
    labels: ['qa-inbox'],
    type: n === 2 ? 'Bug' : 'Story',
    digest: sha(`PROJ-${n}`),
    related: { links: [], paths: [] },
    ...patch,
  });
}

/** Набор поиска: три тикета одного источника. */
export const INBOX_ITEMS = [item(1), item(2), item(3)];

/**
 * Раздел доски, который «записали мимо окна» перед 409: полный по схеме ядра — иначе вторая запись
 * окна (весь документ) не прошла бы `setConfigBodySchema` из-за чужого раздела, а не своего.
 */
const STALE_BOARD = {
  inWork: 4,
  perDay: null,
  paused: false,
  stopOnQuestion: true,
  defaultStop: 'mr',
};

const view = (doc) => ({ doc, digest: sha(JSON.stringify(doc)), drift: null, issues: [] });

/**
 * Подменить ядру входящие поверх подмены доски. `state.doc` — действующая настройка (запись её
 * меняет), `state.mode` — вариации: `staleOnce` (первая запись 409), `searchDelayMs`,
 * `searchProblem`, `searchTruncated`, `entriesRefuse`. Возвращает состояние с телами, ушедшими в ядро.
 */
export async function installCoreInboxStub(page, initialDoc = { v: 1 }) {
  const board = await installCoreBoardStub(page);
  const state = {
    board,
    doc: initialDoc,
    mode: {},
    configs: [],
    searches: [],
    creates: [],
    entries: [],
  };
  await page.route(/\/api\/core\/(config|inbox|board\/entries|nonce)(\/|\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/core/, '');
    const method = request.method();
    if (path === '/nonce') {
      return route.fulfill({ json: { nonce: 'qa-inbox-nonce', expiresAt: Date.now() + 60_000 } });
    }
    if (path === '/config' && method === 'GET') return route.fulfill({ json: view(state.doc) });
    if (path === '/config' && method === 'POST') {
      const body = request.postDataJSON();
      state.configs.push(body);
      if (state.mode.staleOnce) {
        state.mode.staleOnce = false;
        state.doc = { ...state.doc, board: STALE_BOARD };
        return route.fulfill({
          status: 409,
          json: {
            error: 'Настройку уже изменили: перечитайте и повторите',
            code: 'stale-digest',
            digest: view(state.doc).digest,
          },
        });
      }
      if (
        !setConfigBodySchema.safeParse(body).success ||
        body.baseDigest !== view(state.doc).digest
      ) {
        return route.fulfill({ status: 422, json: { error: 'Настройка не принята', code: 'bad' } });
      }
      state.doc = body.doc;
      return route.fulfill({ json: { view: view(state.doc), replayed: false, warnings: [] } });
    }
    if (path === '/inbox/search' && method === 'GET') {
      state.searches.push(Object.fromEntries(url.searchParams));
      if (state.mode.searchDelayMs)
        await new Promise((r) => setTimeout(r, state.mode.searchDelayMs));
      if (state.mode.searchRefuse) {
        return route.fulfill({
          status: 404,
          json: {
            error: 'Источник входящих не найден',
            code: 'unknown-source',
            reason: state.mode.searchRefuse,
          },
        });
      }
      if (state.mode.searchProblem) {
        return route.fulfill({
          json: { items: [], truncated: false, problem: state.mode.searchProblem },
        });
      }
      return route.fulfill({
        json: { items: INBOX_ITEMS, truncated: Boolean(state.mode.searchTruncated) },
      });
    }
    if (path === '/inbox' && method === 'POST') {
      const body = request.postDataJSON();
      state.creates.push(body);
      if (!inboxCreateBodySchema.safeParse(body).success) {
        return route.fulfill({ status: 400, json: { error: 'bad body', code: 'bad-body' } });
      }
      const n = body.create.source === 'search' ? body.create.items.length : 1;
      const created = Array.from(
        { length: n },
        (_, i) => `01900000-0000-7000-8000-0000000e${String(i).padStart(4, '0')}`,
      );
      return route.fulfill({ json: { created, existing: [], replayed: false } });
    }
    if (path === '/board/entries' && method === 'POST') {
      const body = request.postDataJSON();
      state.entries.push(body);
      if (state.mode.entriesRefuse) {
        return route.fulfill({
          status: 501,
          json: { error: state.mode.entriesRefuse, code: 'board-unwired' },
        });
      }
      if (!boardEntriesBodySchema.safeParse(body).success) {
        return route.fulfill({ status: 400, json: { error: 'bad body', code: 'bad-body' } });
      }
      return route.fulfill({
        json: { created: ['01900000-0000-7000-8000-0000000f0001'], replayed: false },
      });
    }
    return route.fallback();
  });
  return state;
}

// --- «Тесты»: прогон с красным, зелёным и заблокированным кейсом (подмена ответов сервера).
export const TESTS_PROJECT = { name: 'QA проект', path: 'C:/qa-project' };
const RUN = {
  id: 'run-inbox-1',
  mode: 'run',
  actor: 'agent',
  status: 'done',
  environmentId: 'local',
  startedAt: '2026-11-08T10:00:00.000Z',
  finishedAt: '2026-11-08T10:20:00.000Z',
  results: [
    {
      pointId: 'gui|gui-001|local',
      groupId: 'gui',
      caseId: 'gui-001',
      status: 'failed',
      note: 'кнопка осталась активной',
      failure: { step: 2, expected: 'кнопка выключена', actual: 'кнопка активна' },
    },
    { pointId: 'gui|gui-002|local', groupId: 'gui', caseId: 'gui-002', status: 'passed' },
    { pointId: 'gui|gui-003|local', groupId: 'gui', caseId: 'gui-003', status: 'blocked' },
  ],
  summary: { total: 3, passed: 1, failed: 1, skipped: 0, blocked: 1 },
};
const TESTS_VIEW = {
  projectPath: TESTS_PROJECT.path,
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
      cases: ['Вход существующим пользователем', 'Выход', 'Настройки'].map((title, i) => ({
        id: `gui-00${i + 1}`,
        type: 'case',
        title,
        steps: [],
        status: ['failed', 'passed', 'blocked'][i],
        source: 'agent',
      })),
    },
  ],
};

/** Ответы сервера разделу «Тесты»: проект, прогон и пустые соседние карточки. */
export async function installTestsRunStub(page) {
  const empty = {
    'project-git': { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
    'project-tests/coverage': { items: [], orphans: [], source: 'links', jql: '' },
    'project-tests/lint': { checked: 3, findings: [], byRule: [], duplicates: [] },
    'project-tests/release': { releases: [] },
    'project-tests/risk': { items: [], checkedAt: '2026-11-08T10:00:00.000Z' },
    'project-tests/plans': { plans: [] },
    'project-tests/manual': {},
    'project-tests/impact': { files: [], cases: [] },
    'project-tests/flaky': { window: 10, minFlips: 2, cases: [] },
    'project-tests/pyramid': {
      frameworks: [],
      split: false,
      truncated: false,
      checkedAt: '2026-11-08T10:00:00.000Z',
    },
    'project-tests/quarantine': {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: '2026-11-08T10:00:00.000Z',
    },
    'project-tests/case-history': {
      groupId: '',
      caseId: '',
      entries: [],
      flaky: { isFlaky: false, flips: 0, runs: 0 },
    },
  };
  for (const [path, json] of Object.entries(empty)) {
    await page.route(`**/api/${path}*`, (route) => route.fulfill({ json }));
  }
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: TESTS_PROJECT.path,
          name: TESTS_PROJECT.name,
          exists: true,
          lastActivity: '2026-11-08T10:00:00.000Z',
          chats: [],
        },
      ],
    }),
  );
  // Порядок важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему обработчику, а `**/run*`
  // подходит и к `/runs`, и к `/run/diff`.
  await page.route('**/api/project-tests/run*', (route) => route.fulfill({ json: { run: RUN } }));
  await page.route('**/api/project-tests/runs*', (route) =>
    route.fulfill({ json: { runs: [RUN] } }),
  );
  await page.route('**/api/project-tests/run/diff*', (route) =>
    route.fulfill({ status: 404, json: { message: 'Сравнивать не с чем: это первый прогон.' } }),
  );
  await page.route('**/api/project-tests/report*', (route) =>
    route.fulfill({
      json: {
        runs: [RUN],
        areas: [],
        automation: { manual: 3, toAutomate: 0, automated: 0 },
        flaky: [],
        failures: [],
        releases: [],
        totals: { runs: 1, tokens: 0, costUsd: 0, durationMs: 0, muted: 0 },
      },
    }),
  );
  await page.route('**/api/project-tests?*', (route) => route.fulfill({ json: TESTS_VIEW }));
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

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // Нет элемента — провал за 8 с, а не 30 с ожидания на каждом шаге упавшего сценария.
  page.setDefaultTimeout(8_000);
  page.errors = [];
  page.sent = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('/api/')) page.sent.push({ url: r.url(), body: r.postData() ?? '' });
  });
  await bypassOnboarding(page);
  return page;
}

const has = async (locator, timeout = 5_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

async function sourcesScenario(page, state) {
  const bar = page.locator('[data-board-inbox]');
  check('над доской строка «Входящие из трекера»', await has(bar, 20_000));
  check(
    'источников нет — так и сказано, счёт 0',
    (await bar.getAttribute('data-board-inbox-sources').catch(() => null)) === '0' &&
      (await has(bar.getByText('Источников нет', { exact: false }))),
  );
  await shoot(page, 'inbox-bar-empty');

  await page.locator('[data-board-inbox-open="sources"]').click();
  const dialog = page.locator('[data-inbox-sources]');
  check('«Источники» открывает окно источников', await has(dialog));
  const system = dialog.getByLabel('Система источника');
  const github = system.locator('option', { hasText: 'GitHub' });
  check(
    'GitHub виден в выборе системы, выбрать его нельзя — «не поддерживается»',
    (await github.count()) === 1 &&
      (await github.isDisabled().catch(() => false)) &&
      /не поддерживается/.test((await github.textContent()) ?? ''),
    await github.textContent().catch(() => 'нет варианта'),
  );

  await system.selectOption('jira');
  await dialog.locator('[data-inbox-add]').click();
  // Карточка ищется по месту: `data-inbox-source` — текущее имя, и оно меняется вместе с полем.
  const jira = dialog.locator('[data-inbox-source-index="0"]');
  check(
    'Jira добавлена карточкой источника с именем «jira»',
    await has(dialog.locator('[data-inbox-source="jira"][data-inbox-source-index="0"]')),
  );
  const autoQueue = jira.getByRole('switch', { name: /Сам в очередь/ });
  check(
    'у нового источника «Сам в очередь» выключено (D28)',
    (await autoQueue.getAttribute('aria-checked').catch(() => null)) === 'false',
  );
  await jira.getByLabel('Метки', { exact: true }).fill('qa-inbox, backend');
  await jira.getByRole('switch', { name: /Только назначенные на меня/ }).click();
  await jira.getByLabel('Репозитории').fill('group/app = C:/work/app');

  // Отрицательный: плохое имя и занятое имя — причина видна, «Сохранить» заперта.
  const idField = jira.getByLabel('Имя источника');
  await idField.fill('Jira Main');
  // «Сохранить» — в подвале окна, вне тела с `data-inbox-sources`.
  const save = page.locator('[data-inbox-save]');
  check(
    'имя «Jira Main» — причина «только латиница…», «Сохранить» заперта',
    (await has(dialog.locator('[data-inbox-problems]').getByText('Jira Main', { exact: false }))) &&
      (await save.isDisabled()),
  );
  await jira.getByLabel('Имя источника').fill('jira');
  // Значение сверх предела схемы ядра — словами окна (поле и предел), без английской прозы zod.
  const labelsField = jira.getByLabel('Метки', { exact: true });
  await labelsField.fill(`qa-inbox, ${'x'.repeat(201)}`);
  const problems = dialog.locator('[data-inbox-problems]');
  check(
    'метка длиннее 200 — «метки — есть значение длиннее 200 знаков», без «Too big», «Сохранить» заперта',
    (await has(problems.getByText('метки — есть значение длиннее 200 знаков', { exact: false }))) &&
      (await problems.getByText('Too big', { exact: false }).count()) === 0 &&
      (await save.isDisabled()),
    (await problems.textContent().catch(() => ''))?.slice(0, 200),
  );
  await labelsField.fill('qa-inbox, backend');

  await system.selectOption('gitlab');
  await dialog.locator('[data-inbox-add]').click();
  const gitlab = dialog.locator('[data-inbox-source-index="1"]');
  check(
    'GitLab добавлен вторым источником',
    await has(dialog.locator('[data-inbox-source="gitlab"][data-inbox-source-index="1"]')),
  );
  await gitlab.getByLabel('Имя источника').fill('jira');
  check(
    'занятое имя «jira» — причина «уже занято», «Сохранить» заперта',
    (await has(
      dialog.locator('[data-inbox-problems]').getByText('уже занято', { exact: false }),
    )) && (await save.isDisabled()),
  );
  await gitlab.getByLabel('Имя источника').fill('gitlab');
  await gitlab.getByRole('switch', { name: /MR, где я ревьюер/ }).click();
  await shoot(page, 'inbox-sources');

  // Вариация: ядро ответило 409 — причина ядра и «Перечитать», без тихой записи.
  state.mode.staleOnce = true;
  await save.click();
  check(
    '409 ядра — его причина в окне, окно не закрылось',
    await has(
      dialog.locator('[data-inbox-error]').getByText('Настройку уже изменили', { exact: false }),
    ),
  );
  check(
    'после 409 предложено «Перечитать настройку»',
    await has(dialog.locator('[data-inbox-reload]')),
  );
  const firstWrite = state.configs.at(-1);
  check(
    'первая запись ушла телом set-config (схема контрактов, отпечаток, раздел inbox)',
    firstWrite &&
      setConfigBodySchema.safeParse(firstWrite).success &&
      Boolean(firstWrite.doc.inbox),
    JSON.stringify(firstWrite)?.slice(0, 300),
  );
  await dialog.locator('[data-inbox-reload]').click();
  // Перечитано: черновик собран заново из новой настройки — источников в ней нет, добавить снова.
  await system.selectOption('jira');
  await dialog.locator('[data-inbox-add]').click();
  const jira2 = dialog.locator('[data-inbox-source-index="0"]');
  await jira2.getByLabel('Метки', { exact: true }).fill('qa-inbox, backend');
  await jira2.getByRole('switch', { name: /Только назначенные на меня/ }).click();
  await jira2.getByLabel('Репозитории').fill('group/app = C:/work/app');
  const before = state.configs.length;
  await save.click();
  await has(page.locator('[data-inbox-sources]'), 500);
  await page.waitForTimeout(800);
  const written = state.configs[before];
  const source = written?.doc?.inbox?.sources?.[0];
  check(
    'запись после «Перечитать» — от нового отпечатка, прочие разделы сохранены (доска, записанная мимо окна)',
    written?.baseDigest === sha(JSON.stringify({ v: 1, board: STALE_BOARD })) &&
      JSON.stringify(written?.doc?.board) === JSON.stringify(STALE_BOARD),
    JSON.stringify(written)?.slice(0, 300),
  );
  check(
    'раздел inbox: Jira, метки, «назначенные на меня», репозиторий; autoQueue false',
    source?.system === 'jira' &&
      source.id === 'jira' &&
      source.enabled === true &&
      source.autoQueue === false &&
      JSON.stringify(source.jira) ===
        JSON.stringify({ labels: ['qa-inbox', 'backend'], assignedToMe: true }) &&
      source.repos['group/app'] === 'C:/work/app',
    JSON.stringify(source),
  );
  check(
    'принятая запись закрывает окно, строка над доской — «1 источник»',
    (await page.locator('[data-inbox-sources]').count()) === 0 &&
      (await page.locator('[data-board-inbox]').getAttribute('data-board-inbox-sources')) === '1',
    (await page
      .locator('[data-inbox-error], [data-inbox-problems]')
      .allTextContents()
      .then((texts) => texts.join(' | '))) +
      ` · sources=${await page.locator('[data-board-inbox]').getAttribute('data-board-inbox-sources')}`,
  );
}

async function searchScenario(page, state) {
  await page.locator('[data-board-inbox-open="search"]').click();
  const dialog = page.locator('[data-inbox-search]');
  check('«Найти в трекере» открывает поиск', await has(dialog));
  await dialog.getByLabel('Запрос').fill(INBOX_JQL);

  // Вариация времени: ответ задержан — «Ищу…», не «Ничего не нашлось».
  state.mode.searchDelayMs = 1500;
  await dialog.locator('[data-inbox-search-run]').click();
  await page.waitForTimeout(400);
  check(
    'пока ответа нет — «Ищу…», ни пустого списка, ни «Ничего не нашлось»',
    (await dialog.locator('[data-inbox-search-pending]').count()) === 1 &&
      (await dialog.getByText('Ничего не нашлось').count()) === 0,
  );
  state.mode.searchDelayMs = 0;
  check('ответ — три тикета списком', await has(dialog.locator('[data-inbox-item="PROJ-3"]')));
  const search = state.searches.at(-1);
  check(
    'поиск ушёл `GET /inbox/search` с источником и запросом человека',
    search?.sourceId === 'jira' && search?.q === INBOX_JQL,
    JSON.stringify(search),
  );
  await dialog.locator('[data-inbox-item="PROJ-1"] input[type="checkbox"]').check();
  await dialog.locator('[data-inbox-item="PROJ-2"] input[type="checkbox"]').check();
  const create = dialog.locator('[data-inbox-create]');
  check(
    'кнопка называет выбранные — «Во входящие (2)»',
    /\(2\)/.test((await create.textContent()) ?? ''),
  );
  await shoot(page, 'inbox-search');
  await create.click();
  check(
    'ответ ядра — «новых 2»',
    await has(dialog.locator('[data-inbox-outcome]').getByText('новых 2', { exact: false })),
  );
  const body = state.creates.at(-1);
  check(
    'один `POST /inbox`: два тикета источника jira, тело по схеме, доказательство страницы',
    state.creates.length === 1 &&
      inboxCreateBodySchema.safeParse(body).success &&
      body.create.source === 'search' &&
      body.create.sourceId === 'jira' &&
      body.create.items.map((i) => i.key).join(',') === 'PROJ-1,PROJ-2',
    JSON.stringify(body)?.slice(0, 300),
  );
  const leaks = page.sent.filter(
    (r) =>
      !r.url.includes('/inbox/search') &&
      (r.body.includes('qa-inbox ORDER') || decodeURIComponent(r.url).includes('qa-inbox ORDER')),
  );
  check(
    'запрос человека — только в поиске: ни одно другое тело и адрес его не несут (P167)',
    leaks.length === 0,
    leaks.map((l) => l.url).join(', '),
  );
  await shoot(page, 'inbox-search-done');

  // «Неизвестно» источника и обрезка — словами, не пустым списком.
  // Проза ядра английская (контракт) — панель называет причину по-русски, прозу кладёт в подсказку.
  const problem = dialog.locator('[data-inbox-problem]');
  const problemRows = [
    ['source jira: jira search: server-error (http 503)', 'трекер не отвечает'],
    ['source jira: jira search: unauthorized (http 401)', 'нет доступа'],
    ['source jira: something the panel never saw', 'Источник не ответил'],
  ];
  for (const [raw, line] of problemRows) {
    state.mode.searchProblem = raw;
    await dialog.locator('[data-inbox-search-run]').click();
    check(
      `источник не ответил («${line}») — причина по-русски, проза ядра только в подсказке, без «Ничего не нашлось»`,
      (await has(problem.getByText(line, { exact: false }))) &&
        (await problem.getByText('jira search', { exact: false }).count()) === 0 &&
        (await problem.getByText('panel never saw', { exact: false }).count()) === 0 &&
        (await problem.getAttribute('title')) === raw &&
        (await dialog.getByText('Ничего не нашлось').count()) === 0,
      (await problem.textContent().catch(() => ''))?.slice(0, 200),
    );
  }
  state.mode.searchProblem = '';
  // Отказ ядра (404, источника нет в настройке) — по-русски, проза ядра в подсказке, без списка.
  state.mode.searchRefuse = 'no inbox source jira in the config';
  await dialog.locator('[data-inbox-search-run]').click();
  const refused = dialog.locator('[data-inbox-search-error]');
  check(
    'отказ ядра поиску — «источника нет в настройке ядра», без английской прозы и без списка',
    (await has(refused.getByText('нет в настройке ядра', { exact: false }))) &&
      (await refused.getByText('in the config', { exact: false }).count()) === 0 &&
      (await refused.getAttribute('title')) === 'no inbox source jira in the config' &&
      (await dialog.locator('[data-inbox-item]').count()) === 0,
    (await refused.textContent().catch(() => ''))?.slice(0, 200),
  );
  state.mode.searchRefuse = '';
  state.mode.searchTruncated = true;
  await dialog.locator('[data-inbox-search-run]').click();
  check(
    'обрезанный ответ — подпись «показаны не все»',
    await has(dialog.locator('[data-inbox-truncated]')),
  );
  state.mode.searchTruncated = false;
  await page.keyboard.press('Escape');
}

async function testsScenario(browser) {
  const page = await newPage(browser);
  const state = await installCoreInboxStub(page);
  await installTestsRunStub(page);
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
  }, TESTS_PROJECT);
  await page.goto(`${BASE}/tests?tab=runs`, { waitUntil: 'domcontentloaded' });
  const head = page.locator('[id^="run-card-"] button[aria-expanded]').first();
  if (!(await has(head, 20_000))) {
    check('запись прогона раскрывается', false, 'нет записи прогона');
    await page.close();
    return;
  }
  await head.click();
  const red = page.locator('[data-tests-to-board="gui:gui-001"]');
  check('у красного кейса — «На доску»', await has(red));
  check(
    'у зелёного и заблокированного кнопки нет',
    (await page
      .locator('[data-tests-to-board="gui:gui-002"], [data-tests-to-board="gui:gui-003"]')
      .count()) === 0,
  );
  await shoot(page, 'tests-to-board');

  // Отказ ядра — причиной, кнопка не выдаёт «На доске».
  state.mode.entriesRefuse = 'board is not wired';
  await red.click();
  check(
    'отказ ядра — причина у кнопки',
    await has(
      page.locator('[data-tests-to-board-error]').getByText('board is not wired', { exact: false }),
    ),
  );
  await page.waitForTimeout(400);
  check(
    'один отказ — одно сообщение: у кнопки, без общего тоста поверх',
    (await page.getByText('board is not wired', { exact: false }).count()) === 1,
    `${await page.getByText('board is not wired', { exact: false }).count()} copies`,
  );
  state.mode.entriesRefuse = '';
  await red.click();
  check(
    'принято ядром — кнопка «На доске», нажать второй раз нельзя',
    (await has(
      page.locator('[data-tests-to-board="gui:gui-001"][data-tests-to-board-state="done"]'),
    )) && (await page.locator('[data-tests-to-board="gui:gui-001"]').isDisabled()),
  );
  const body = state.entries.at(-1);
  const entry = body?.entries?.[0];
  const fields = entry?.launch?.fields ?? {};
  check(
    'запись во «Входящие»: источник tests, ключ кейса, пресет bug-fix, тело по схеме',
    boardEntriesBodySchema.safeParse(body).success &&
      body.to === 'inbox' &&
      entry.source.kind === 'tests' &&
      entry.source.key === 'gui/gui-001' &&
      entry.preset === 'bug-fix',
    JSON.stringify(body)?.slice(0, 400),
  );
  check(
    'поля оценки: разбор провала (ожидалось/вышло/прогон) и репозиторий проекта',
    typeof fields.request === 'string' &&
      fields.request.includes('кнопка выключена') &&
      fields.request.includes('кнопка активна') &&
      fields.request.includes('run-inbox-1') &&
      JSON.stringify(fields.repos) ===
        JSON.stringify([{ path: TESTS_PROJECT.path, baseRef: null }]),
    JSON.stringify(fields).slice(0, 400),
  );
  check(
    'второе нажатие после отказа — второй запрос, причина отказа снята',
    state.entries.length === 2 && (await page.locator('[data-tests-to-board-error]').count()) === 0,
    `entries posted: ${state.entries.length}`,
  );
  await shoot(page, 'tests-to-board-done');

  // Ядро записей по ключу кейса не склеивает: «На доске» после перезагрузки держит сама доска —
  // открытая карточка с источником tests и тем же ключом. Запись легла на доску, как у ядра.
  const onBoard = {
    ...state.board.cards[0],
    id: '019a0000-0000-7000-8000-00000000a0b1',
    entryId: '019a0000-0000-7000-8000-00000000a0b1',
    column: 'inbox',
    state: 'inbox',
    title: entry?.source?.title ?? 'Тест падает',
    source: { kind: 'tests', key: 'gui/gui-001', title: entry?.source?.title ?? 'Тест падает' },
    moves: ['queue', 'rejected'],
  };
  state.board.cards.push(onBoard);
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const head2 = page.locator('[id^="run-card-"] button[aria-expanded]').first();
    if (await has(head2, 20_000)) await head2.click();
    await has(page.locator('[data-tests-to-board="gui:gui-001"]'));
    await page.waitForTimeout(600);
  };
  await reopen();
  const posted = state.entries.length;
  const again = page.locator('[data-tests-to-board="gui:gui-001"]');
  check(
    'после перезагрузки кейс, чья запись уже на доске, — «На доске», второй записи не будет',
    (await has(
      page.locator('[data-tests-to-board="gui:gui-001"][data-tests-to-board-state="done"]'),
    )) && (await again.isDisabled()),
  );
  await again.click({ force: true, timeout: 2000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  check('нажатие по «На доске» ничего не шлёт', state.entries.length === posted);
  onBoard.column = 'merged';
  await reopen();
  check(
    'карточка кейса влита — красный снова кладётся на доску',
    !(await page.locator('[data-tests-to-board="gui:gui-001"]').isDisabled()) &&
      (await page
        .locator('[data-tests-to-board="gui:gui-001"][data-tests-to-board-state="done"]')
        .count()) === 0,
  );
  check('страница «Тестов» без ошибок', page.errors.length === 0, page.errors.join('; '));
  await page.close();
}

/** Отказ ядра на «Задачу из трекера» без снимка тикета — та же проза, что пишет `moves.ts`. */
const TICKET_REFUSAL =
  'preset tracker-ticket: the tracker-ticket preset needs a tracker snapshot in the launch source (kind tracker)';
/** Отказ, которого панель ещё не знает: общая строка, проза ядра — только подсказкой. */
const NEW_REFUSAL = 'preset lead: a brand-new prerequisite the panel does not map yet';

/**
 * «Сценарий» записи до старта (W2-D, P164): выбор виден у записи, которой ядро разрешило ход
 * `set-preset`, и только у неё; смена уходит ОДНИМ ходом `set-preset` с пресетом (тело по схеме),
 * отказ ядра — его причиной под выбором, пресет прежний.
 */
async function presetScenario(page, state) {
  const card = state.board.cards.find((c) => c.id === BOARD_IDS.inbox);
  card.moves = [...card.moves, 'set-preset'];
  const sent = [];
  await page.route(/\/api\/core\/board\/move$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body?.to !== 'set-preset') return route.fallback();
    sent.push(body);
    if (!boardMoveBodySchema.safeParse(body).success)
      return route.fulfill({ status: 400, json: { error: 'bad body', code: 'bad-board-move' } });
    if (body.preset === 'tracker-ticket' || body.preset === 'lead') {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Ход доски не разрешён',
          code: 'move-not-allowed',
          allowed: card.moves,
          reason: body.preset === 'lead' ? NEW_REFUSAL : TICKET_REFUSAL,
        },
      });
    }
    card.preset = body.preset;
    return route.fulfill({ json: { cards: state.board.cards, entries: [], replayed: false } });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(`[data-board-card="${BOARD_IDS.inbox}"]`).click();
  const modal = page.locator(`[data-card-modal="${BOARD_IDS.inbox}"]`);
  const picker = modal.locator('[data-entry-preset]');
  check('у записи во «Входящих» — выбор «Сценарий»', await has(picker));
  const select = picker.locator('select');
  check('выбран нынешний пресет записи', (await select.inputValue()) === 'feature');
  await shoot(page, 'entry-preset');
  await select.selectOption('tracker-ticket');
  const refusal = modal.locator('[data-entry-preset-error]');
  check(
    'отказ ядра — причина под выбором по-русски, называет недостающее; проза ядра только в подсказке',
    (await has(refusal.getByText('нужен снимок тикета', { exact: false }))) &&
      (await refusal.getByText('tracker snapshot', { exact: false }).count()) === 0 &&
      (await refusal.getAttribute('title')) === TICKET_REFUSAL,
    (await refusal.textContent().catch(() => ''))?.slice(0, 200),
  );
  check('после отказа пресет прежний', card.preset === 'feature');
  await shoot(page, 'entry-preset-refused');
  await select.selectOption('lead');
  check(
    'незнакомый отказ ядра — общее «Ядро отказало», проза ядра только в подсказке',
    (await has(refusal.getByText('Ядро отказало', { exact: false }))) &&
      (await refusal.getByText('brand-new', { exact: false }).count()) === 0 &&
      (await refusal.getAttribute('title')) === NEW_REFUSAL,
    (await refusal.textContent().catch(() => ''))?.slice(0, 200),
  );
  await select.selectOption('bug-fix');
  await page.waitForTimeout(400);
  const last = sent.at(-1);
  check(
    'смена — один ход set-preset с пресетом, тело по схеме',
    sent.length === 3 &&
      last.to === 'set-preset' &&
      last.preset === 'bug-fix' &&
      last.entryId === BOARD_IDS.inbox &&
      boardMoveBodySchema.safeParse(last).success,
    JSON.stringify(last)?.slice(0, 300),
  );
  check(
    'после ответа ядра — новый пресет, причина снята',
    (await has(modal.locator('[data-entry-preset="bug-fix"]'))) &&
      (await modal.locator('[data-entry-preset-error]').count()) === 0,
  );
  await page.keyboard.press('Escape');
  await page.locator(`[data-board-card="${BOARD_IDS.queued}"]`).click();
  const queued = page.locator(`[data-card-modal="${BOARD_IDS.queued}"]`);
  await has(queued);
  check(
    'запись без хода set-preset (ядро не разрешило) — выбора нет',
    (await queued.locator('[data-entry-preset]').count()) === 0,
  );
  await page.keyboard.press('Escape');
}

/** Сценарий упал исключением (нет элемента, таймаут) — строка провала, следующий идёт дальше. */
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    check(`сценарий «${name}» дошёл до конца`, false, message);
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    const state = await installCoreInboxStub(page);
    await page.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    await page
      .locator('[data-core-board]')
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    await step('источники', () => sourcesScenario(page, state));
    await step('поиск', () => searchScenario(page, state));
    await step('сценарий записи', () => presetScenario(page, state));
    check('доска без ошибок страницы', page.errors.length === 0, page.errors.join('; '));
    await page.close();
    await step('тесты', () => testsScenario(browser));
  } finally {
    await browser.close();
  }
  console.table(rows);
  console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
