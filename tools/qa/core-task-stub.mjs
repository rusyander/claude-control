/**
 * Подменная задача ядра для обходов доступности и клавиатуры (`panel-pages.mjs`): страница
 * `/core?id=<CORE_STUB_TASK_ID>` на живом стенде без настоящего ядра и без чужих задач. `page.route`
 * отвечает за три адреса прокладки — вид задачи, поток строк журнала (SSE) и отчёт; остальное
 * (здоровье ядра, число страницы) идёт на стенд как есть. Вид задачи проверяется схемой контрактов
 * при загрузке модуля: подмена, разошедшаяся с контрактом, падает здесь, а не рисует то, чего ядро
 * не отдаст.
 *
 * В журнале — все виды строк, что рисует лента: решения с причинами, шаг, вопрос человеку (карточка
 * с кнопками — клавиатурный путь), сигналы обеих форм детали (проза и JSON) и сигнал вне каталога.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { taskViewSchema } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/core/task-view.ts')).href
);

export const CORE_STUB_TASK_ID = '01900000-0000-7000-8000-00000000a11e';
const STEP = '01900000-0000-7000-8000-00000000a201';
const UNIT = '01900000-0000-7000-8000-00000000a301';
const ASK = '01900000-0000-7000-8000-00000000a401';
const AT = Date.UTC(2026, 10, 1, 9, 0, 0);

const signal = (signal, severity, subject, detail, action) => ({
  signal,
  severity,
  subject,
  detail,
  ...(action ? { action } : {}),
});

const LINES = [
  ['task.created', { title: 'Лента задачи: проверка доступности' }],
  [
    'signal',
    signal(
      'preflight',
      'info',
      'estimate',
      JSON.stringify([
        { road: 'cli', status: 'ok', detail: 'claude 2.1.0' },
        { road: 'route', status: 'ok', detail: 'stub:stand (stub)' },
        { road: 'push-closure', status: 'not-checked', detail: 'arrives with publish (05)' },
      ]),
    ),
  ],
  [
    'signal',
    signal(
      'estimate-history',
      'info',
      'estimate',
      JSON.stringify({ minutes: 12, tokens: 34000, spread: [20000, 50000], basis: 'history' }),
    ),
  ],
  [
    'decision',
    {
      decisionId: '01900000-0000-7000-8000-00000000a501',
      class: 'next',
      reasons: ['unit has a queued step and no live session'],
      output: { kind: 'start-step' },
    },
  ],
  ['step.started', { stepId: STEP, stepKind: 'implement', stepDefId: 'implement', round: 0 }],
  [
    'signal',
    signal(
      'route-lease',
      'info',
      '01900000-0000-7000-8000-00000000a601',
      JSON.stringify({ routeId: 'stub:stand', model: 'stub-model', rids: ['rid-1'] }),
    ),
  ],
  [
    'signal',
    signal(
      'hook-block',
      'warn',
      'PreToolUse:guard',
      'Bash on PreToolUse: command writes outside the copy',
      'show',
    ),
  ],
  ['signal', signal('ownership', 'warn', UNIT, 'docs/readme.md\nsrc/extra.ts')],
  [
    'decision',
    {
      decisionId: '01900000-0000-7000-8000-00000000a502',
      class: 'permit',
      reasons: ['target inside unit paths'],
      output: { allow: true, action: 'edit', target: 'src/app.ts' },
    },
  ],
  [
    'human.asked',
    {
      askId: ASK,
      stepId: STEP,
      point: 6,
      source: 'ask_human',
      question: 'Продолжать без проверки сборки?',
      options: ['да', 'нет'],
      defaultAction: null,
    },
  ],
  ['signal', signal('brand-new-signal', 'info', 'probe', JSON.stringify({ a: 1, list: [1, 2] }))],
  [
    'signal',
    signal('stall', 'stop', '01900000-0000-7000-8000-00000000a701', 'quiet 600 s', 'stop-step'),
  ],
];

const JOURNAL = LINES.map(([kind, data], i) => ({
  v: 1,
  seq: i + 1,
  at: AT + i * 1000,
  kind,
  ...(kind === 'step.started' || kind === 'human.asked' ? { stepId: STEP } : {}),
  data,
}));

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };

export const CORE_STUB_VIEW = taskViewSchema.parse({
  taskId: CORE_STUB_TASK_ID,
  seq: JOURNAL.length,
  state: 'running',
  ended: null,
  steps: [
    {
      stepId: STEP,
      unitId: UNIT,
      stepKind: 'implement',
      stepDefId: 'implement',
      round: 0,
      state: 'running',
      startedSeq: 5,
      budgetMs: 600000,
      outcome: null,
      reason: null,
    },
  ],
  sessions: [],
  checks: [],
  asks: [
    {
      askId: ASK,
      state: 'open',
      point: 6,
      source: 'ask_human',
      dedupe: null,
      stepId: STEP,
      lateAnswer: false,
      answer: null,
    },
  ],
  budgets: [{ scope: 'task', spent: 1200, limit: 5000, seq: 1 }],
  windows: [],
  spend: {
    tokens: { ...zero, input: 1000, output: 200, turns: 2 },
    cost: { usd: 0.01, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 2 },
    bySession: {},
    byStep: {},
  },
  report: null,
  scenario: null,
  split: null,
  attention: null,
});

/** Кадры SSE после `Last-Event-ID`: переподключение получает только хвост, как у ядра. */
function framesAfter(lastId) {
  const after = Number.parseInt(lastId ?? '0', 10) || 0;
  return JOURNAL.filter((l) => l.seq > after)
    .map((l) => `id: ${l.seq}\nevent: ${l.kind}\ndata: ${JSON.stringify(l)}\n\n`)
    .join('');
}

/** Подмена трёх адресов задачи; переживает `reload` (так `prepare` обхода и работает). */
export async function installCoreTaskStub(page) {
  const base = `**/api/core/tasks/${CORE_STUB_TASK_ID}`;
  await page.route(base, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: null, live: true, view: CORE_STUB_VIEW }),
    }),
  );
  await page.route(`${base}/events*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: framesAfter(route.request().headers()['last-event-id']),
    }),
  );
  await page.route(`${base}/report*`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'no-report' }),
    }),
  );
}
