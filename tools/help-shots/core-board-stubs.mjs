/**
 * Подмены ответов для кадров доски ядра, окна карточки, карточки лимита чата и заметок к правкам
 * (`core-board.mjs`). Правило то же, что у `tools/qa/check-*.mjs`: подменяется ОТВЕТ сервера на
 * границе сети, а разметку, подписи и состояния рисует настоящий код панели. Формы ответов — те же,
 * что у проверок `tools/qa/check-core-board.mjs`, `check-limit-card.mjs`, `check-chat-limit-card.mjs`
 * и `check-project-code.mjs`; вид задачи проходит схему контракта до браузера.
 *
 * Данные — на языке кадра: русский кадр с английскими названиями карточек читался бы как
 * недоделанный перевод. Пути — выдуманные и не похожие на машину съёмки.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './kit.mjs';
import { PROJECT } from './chat-stubs.mjs';

const { taskViewSchema } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/contracts/src/core/task-view.ts')).href
);

const id = (n) => `01900000-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`;
export const IDS = {
  inbox: id(1),
  queued: id(2),
  work: id(3),
  unitTwo: id(4),
  waiting: id(5),
  window: id(6),
  review: id(7),
  mr: id(8),
  takeover: id(9),
  closed: id(10),
  laneTwo: id(11),
};
const GROUP_A = '01900000-0000-7000-8000-00000000a11a';
const GROUP_B = '01900000-0000-7000-8000-00000000b22b';
const STEP = id(201);
const UNIT = id(301);
const AT = Date.UTC(2026, 10, 8, 9, 0, 0);
const RESET = Date.UTC(2026, 10, 8, 14, 30, 0);
const ROUTE = 'claude-login';

/** Названия карточек на языке кадра. */
const TITLES = {
  ru: {
    inbox: 'Разобрать журнал сборки',
    queued: 'Обновить справку раздела',
    work: 'Починить парсер заказов',
    unitTwo: 'Добавить тест парсера',
    waiting: 'Выбрать формат отчёта',
    window: 'Перевести письма на шаблоны',
    review: 'Убрать дубли в настройках',
    mr: 'Кнопка экспорта в CSV',
    takeover: 'Свести стили таблицы',
    closed: 'Старая задача',
    laneTwo: 'Описать итог релиза',
    mrTitle: 'Экспорт заказов в CSV',
  },
  en: {
    inbox: 'Triage the build log',
    queued: 'Update the section help',
    work: 'Fix the order parser',
    unitTwo: 'Add a parser test',
    waiting: 'Pick the report format',
    window: 'Move emails to templates',
    review: 'Drop duplicate settings',
    mr: 'CSV export button',
    takeover: 'Unify the table styles',
    closed: 'Old task',
    laneTwo: 'Write the release summary',
    mrTitle: 'Export orders to CSV',
  },
};

function card(key, lang, patch) {
  return {
    kind: 'task',
    id: IDS[key],
    taskId: IDS[key],
    title: TITLES[lang][key],
    stop: 'mr',
    waiting: false,
    questions: 0,
    takeover: null,
    moves: [],
    createdAt: AT,
    ...patch,
  };
}

function entry(key, lang, patch) {
  const { taskId: _drop, ...rest } = card(key, lang, patch);
  return { ...rest, kind: 'entry', entryId: IDS[key] };
}

/** Доска: запись во «Входящих», очередь, задачи по стадиям, две группы, ждущая, MR, закрытая. */
export function boardCards(lang) {
  const title = TITLES[lang];
  return [
    entry('inbox', lang, {
      column: 'inbox',
      state: 'inbox',
      stop: 'plan',
      preset: 'feature',
      source: { kind: 'manual', title: title.inbox },
      moves: ['queue', 'rejected'],
    }),
    entry('queued', lang, {
      column: 'queue',
      state: 'queued',
      preset: 'feature',
      source: { kind: 'chat', title: title.queued },
      rank: 1,
      moves: ['inbox', 'rejected'],
    }),
    card('work', lang, {
      column: 'work',
      state: 'running',
      groupId: GROUP_A,
      units: { done: 1, total: 3 },
      lead: { profile: 'balanced', class: 'L' },
      startedAt: AT + 60_000,
    }),
    card('unitTwo', lang, { column: 'triage', state: 'running', groupId: GROUP_A, questions: 1 }),
    card('waiting', lang, { column: 'waiting', state: 'running', waiting: true, questions: 1 }),
    card('window', lang, {
      column: 'waiting',
      state: 'waiting-window',
      waiting: true,
      reason: `route ${ROUTE} refused by its window; waits for the reset`,
    }),
    card('review', lang, { column: 'review', state: 'running', groupId: GROUP_B }),
    card('laneTwo', lang, { column: 'check', state: 'running', groupId: GROUP_B }),
    card('takeover', lang, {
      column: 'work',
      state: 'paused',
      takeover: { unitId: UNIT, copy: 'copies/7f3a/unit-1', chatTaskId: IDS.takeover },
    }),
    card('mr', lang, {
      column: 'mr',
      state: 'done',
      mr: {
        url: 'https://tracker.example.com/proj/app/-/merge_requests/42',
        iid: 42,
        title: title.mrTitle,
        state: 'opened',
      },
    }),
    card('closed', lang, { column: 'closed', state: 'done' }),
  ];
}

export const LIMITS = {
  inWork: { used: 2, cap: 2 },
  perDay: { used: 4, cap: 10 },
  paused: false,
  stopOnQuestion: false,
  defaultStop: 'mr',
};

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };

/** Состояние задачи в виде: перехваченная стоит — ядро встало на безопасной точке и отдало слот. */
function stateOf(taskId, windowWait) {
  if (windowWait) return 'waiting-window';
  return taskId === IDS.takeover ? 'paused' : 'running';
}

/** Вид задачи для окна карточки: у задачи в ожидании окна — `windowWait` с вариантами перевода. */
export function taskView(taskId, { windowWait = false } = {}) {
  return taskViewSchema.parse({
    taskId,
    seq: 6,
    state: stateOf(taskId, windowWait),
    ended: null,
    steps: [
      {
        stepId: STEP,
        unitId: UNIT,
        stepKind: 'implement',
        stepDefId: 'work',
        round: 0,
        state: 'running',
        startedSeq: 3,
        budgetMs: 600000,
        outcome: null,
        reason: null,
      },
    ],
    sessions: [],
    checks: [],
    asks: [],
    budgets: [],
    windows: [],
    spend: {
      tokens: { ...zero, input: 48_000, output: 6_200, turns: 9 },
      cost: { usd: 0.4, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 9 },
      bySession: {},
      byStep: {},
    },
    report: null,
    scenario: null,
    split: null,
    attention: null,
    ...(windowWait
      ? {
          windowWait: {
            stepId: STEP,
            routeId: ROUTE,
            verdict: 'refused',
            resetAt: RESET,
            alternatives: [],
            skipped: [`cli-login:${ROUTE}=refused`],
            offers: ['cli:codex', 'model:claude-sonnet-4-5'],
            seq: 6,
          },
        }
      : {}),
  });
}
// Подмена, разошедшаяся с контрактом, падает здесь, до браузера.
taskView(IDS.window, { windowWait: true });

const CORE = /\/api\/core\/(board|nonce|tasks|commands)(\/|\?|$)/;

/**
 * Ответы ядра доске и окну карточки. `state.lang` — язык данных, `state.configIssues` — доска
 * назвала ошибку раздела `board`. Ход и запись «В очередь» отвечают как ядро, но ничего не пишут.
 */
export async function installBoardStub(page, state) {
  await page.route(CORE, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    const reply = () => ({
      cards: boardCards(state.lang),
      entries: [],
      limits: LIMITS,
      ...(state.configIssues
        ? { configIssues: [{ section: 'board', reason: 'board.inWork: expected 1 | 2 | 4 | 6' }] }
        : {}),
    });
    if (path === '/board') return route.fulfill({ json: reply() });
    if (path === '/board/entries' && request.method() === 'POST') {
      return route.fulfill({ json: { ...reply(), replayed: false, created: [IDS.queued] } });
    }
    if (path === '/board/move' && request.method() === 'POST') {
      return route.fulfill({ json: { ...reply(), replayed: false } });
    }
    if (path === '/nonce') {
      return route.fulfill({ json: { nonce: 'help-board', expiresAt: Date.now() + 60_000 } });
    }
    if (path === '/commands' && request.method() === 'POST') {
      const body = request.postDataJSON();
      return route.fulfill({ json: { cmdId: body.cmdId, status: 'applied', seq: 7 } });
    }
    if (path === '/tasks') {
      const tasks = boardCards(state.lang)
        .filter((c) => c.kind === 'task')
        .map((c, i) => ({
          taskId: c.taskId,
          live: c.column !== 'closed',
          seq: i + 1,
          state: c.state,
          ended: null,
          title: c.title,
          attention: null,
        }));
      return route.fulfill({ json: { tasks } });
    }
    const task = /^\/tasks\/([^/]+)(\/.*)?$/.exec(path);
    if (task?.[2]?.startsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }
    if (task?.[2]?.startsWith('/report')) {
      return route.fulfill({ status: 404, json: { error: 'no-report' } });
    }
    if (task && !task[2]) {
      return route.fulfill({
        json: {
          task: null,
          live: true,
          view: taskView(task[1], { windowWait: task[1] === IDS.window }),
        },
      });
    }
    return route.fallback();
  });
}

// ── Чат: карточка лимита ─────────────────────────────────────────────────────────────────────

export const CHAT = '5b2d7c1e-3f4a-4b6c-8d9e-0a1b2c3d4e60';
const CHAT_TASK = id(401);
const CHAT_TEXT = {
  ru: {
    title: 'Почини сборку графиков',
    ask: 'Посмотри, почему не собираются графики.',
    answer: 'Сборка падает на импорте темы — нашёл место.',
    next: 'Почини импорт темы и пересобери.',
  },
  en: {
    title: 'Fix the charts build',
    ask: 'See why the charts do not build.',
    answer: 'The build fails on the theme import — found the spot.',
    next: 'Fix the theme import and rebuild.',
  },
};
export const chatText = (lang) => CHAT_TEXT[lang];

const detectRow = (cli, cliInstalled, configPresent) => ({
  id: cli,
  name: cli,
  status: 'verified',
  cliCommand: cli,
  cliInstalled,
  configPresent,
  configPaths: [],
});

/** Поток хода: задача ядра, окно отказало, ход кончился ошибкой лимита (как `core-run`). */
function limitTurn() {
  const frames = [
    { kind: 'coreTask', taskId: CHAT_TASK, project: PROJECT.name },
    { kind: 'limit', resetsAt: Math.floor(RESET / 1000), type: 'five_hour', status: 'rejected' },
    { kind: 'error', message: "You've hit your limit · resets 2:30pm" },
    { kind: 'done', costUsd: 0, durationMs: 1200, sessionId: CHAT },
  ];
  return frames.map((f, i) => `data: ${JSON.stringify({ ...f, seq: i + 1 })}\n\n`).join('');
}

/** Разговор проекта, его лента, детект CLI и ход, упирающийся в лимит. Записей нет. */
export async function installChatLimitStub(page, state) {
  const chatRow = () => ({
    id: CHAT,
    title: chatText(state.lang).title,
    project: PROJECT.name,
    projectPath: PROJECT.path,
    isSandbox: false,
    messageCount: 2,
    createdAt: '2026-11-08T08:30:00.000Z',
    updatedAt: '2026-11-08T09:00:00.000Z',
    preview: '',
  });
  await page.route('**/api/chats', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [chatRow()] }) : route.fallback(),
  );
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: PROJECT.path,
          name: PROJECT.name,
          exists: true,
          lastActivity: '2026-11-08T09:00:00.000Z',
          chats: [chatRow()],
        },
      ],
    }),
  );
  await page.route(`**/api/chats/${CHAT}/messages*`, (route) => {
    const text = chatText(state.lang);
    return route.fulfill({
      json: {
        messages: [
          {
            id: 'help-l-1',
            role: 'user',
            blocks: [{ type: 'text', text: text.ask }],
            timestamp: '2026-11-08T08:30:00.000Z',
          },
          {
            id: 'help-l-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: text.answer }],
            timestamp: '2026-11-08T08:31:00.000Z',
          },
        ],
        total: 2,
        hasMore: false,
      },
    });
  });
  await page.route('**/api/providers/detect', (route) =>
    route.fulfill({
      json: {
        active: 'claude',
        providers: [
          detectRow('claude', true, true),
          detectRow('codex', true, true),
          detectRow('gemini', true, true),
          detectRow('qwen', true, false),
        ],
      },
    }),
  );
  await page.route('**/api/chat/core-cli/**', (route) =>
    route.fulfill({ json: { cli: 'claude' } }),
  );
  await page.route('**/api/chat/send', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: limitTurn() }),
  );
  await page.route(CORE, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/board') {
      return route.fulfill({
        json: { cards: boardCards(state.lang), entries: [], limits: LIMITS },
      });
    }
    if (path === '/nonce')
      return route.fulfill({ json: { nonce: 'help-chat', expiresAt: Date.now() + 60_000 } });
    if (path === '/commands' && request.method() === 'POST') {
      const body = request.postDataJSON();
      return route.fulfill({ json: { cmdId: body.cmdId, status: 'applied', seq: 6 } });
    }
    if (path === `/tasks/${CHAT_TASK}`) {
      return route.fulfill({
        json: { task: null, live: true, view: taskView(CHAT_TASK, { windowWait: true }) },
      });
    }
    if (path.startsWith(`/tasks/${CHAT_TASK}/events`))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return route.fallback();
  });
}

// ── Окно «Код проекта»: заметки к правкам ───────────────────────────────────────────────────

const BEFORE = [
  'export function parseOrder(line: string) {',
  "  const parts = line.split(',');",
  '  return { id: parts[0], total: parts[1] };',
  '}',
  '',
].join('\n');
const AFTER = [
  'export function parseOrder(line: string) {',
  "  const parts = line.split(';');",
  '  const total = Number(parts[1]);',
  '  return { id: parts[0], total };',
  '}',
  '',
].join('\n');

/** Дифф одного файла, тронутого агентом: окно кода открывает его само. */
export async function installCodeStub(page) {
  let view = null;
  await page.route('**/api/project-files/view*', (route) => {
    const method = route.request().method();
    if (method === 'PUT') view = route.request().postDataJSON().view;
    if (method === 'DELETE') view = null;
    return route.fulfill({ json: method === 'GET' ? view : { ok: true } });
  });
  await page.route('**/api/project-files/layout*', (route) =>
    route.fulfill({ json: { treeWidth: 260 } }),
  );
  await page.route('**/api/project-files/changes*', (route) =>
    route.fulfill({
      json: {
        files: [{ path: 'src/parse.ts', added: 2, removed: 2, missing: false }],
        skipped: 0,
      },
    }),
  );
  await page.route('**/api/project-files/tree*', (route) => {
    const dir = new URL(route.request().url()).searchParams.get('dir') ?? '';
    return route.fulfill({
      json:
        dir === 'src'
          ? {
              dir: 'src',
              entries: [{ name: 'parse.ts', path: 'src/parse.ts', isDir: false, sizeBytes: 160 }],
              truncated: false,
            }
          : {
              dir: '',
              entries: [
                { name: 'src', path: 'src', isDir: true },
                { name: 'README.md', path: 'README.md', isDir: false, sizeBytes: 40 },
              ],
              truncated: false,
            },
    });
  });
  await page.route('**/api/project-files/content*', (route) =>
    route.fulfill({
      json: {
        path: 'src/parse.ts',
        content: AFTER,
        baseline: BEFORE,
        kind: 'exact',
        added: 2,
        removed: 2,
        unmatched: 0,
        isBinary: false,
        sizeBytes: 160,
        mtimeMs: 555,
        tooBig: false,
        isReadOnly: false,
      },
    }),
  );
}
