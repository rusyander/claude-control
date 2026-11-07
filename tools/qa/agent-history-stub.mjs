/**
 * Подменные «Агенты» чата для кадров справки (`tools/help-shots/chat-agents.mjs`) и обходов
 * доступности и клавиатуры (`panel-pages.mjs`): разговор `AGENT_HISTORY_CHAT` с планом агента и
 * узлами ядра — главный сеанс, два субагента (один вложен), фоновая команда «идёт», законченная
 * с кодом 0 и осиротевшая после уборки. `page.route` отвечает за список чатов, ленту, прогресс,
 * список узлов ядра, узел подробно и поток дерева; остальное идёт на стенд как есть.
 *
 * Список и узлы проверяются схемами контрактов ядра при загрузке модуля: подмена, разошедшаяся с
 * контрактом, падает здесь, а не рисует то, чего ядро не отдаст. Всё придумано: репозиторий
 * публичный.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { agentNodeDetailSchema, agentsListReplySchema } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/core/agents.ts')).href
);
const { chatProgressSchema } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/chat.ts')).href
);

export const AGENT_HISTORY_CHAT = '7a1c2e90-4b5d-4f6e-8a7b-9c0d1e2f3a4b';
const TASK = '01900000-0000-7000-8000-0000000a9e01';
const STEP = '01900000-0000-7000-8000-0000000a9e02';
const SESSION = '01900000-0000-7000-8000-0000000a9e03';
const UNIT = null;

export const AGENT_HISTORY_IDS = {
  session: SESSION,
  explore: 'toolu_qa_explore',
  review: 'toolu_qa_review',
  tests: 'toolu_qa_tests',
  bgRunning: 'bg_qa_dev',
  bgDone: 'bg_qa_build',
  bgOrphan: 'bg_qa_watch',
};

/** Узел ядра с общими полями; `over` — то, чем он отличается. */
function node(start, over) {
  return {
    parentId: SESSION,
    taskId: TASK,
    kind: 'subagent',
    status: 'completed',
    stepId: STEP,
    unitId: UNIT,
    sessionId: SESSION,
    model: null,
    effort: null,
    background: false,
    startedAt: start,
    endedAt: null,
    spend: { tokens: null, windowShare: null },
    counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
    signals: [],
    briefExcerpt: null,
    returnExcerpt: null,
    ...over,
  };
}

function chain(toolUseId, parentToolUseId = null) {
  return {
    taskId: TASK,
    stepId: STEP,
    unitId: UNIT,
    sessionId: SESSION,
    toolUseId,
    parentToolUseId,
  };
}

/** Узлы разговора на момент `now`: времена отсчитаны назад, чтобы «за 3м» не стало сутками. */
export function agentHistoryNodes(now = Date.now()) {
  const ago = (min) => now - min * 60_000;
  const I = AGENT_HISTORY_IDS;
  return [
    node(ago(12), {
      nodeId: SESSION,
      parentId: null,
      kind: 'unit-session',
      status: 'running',
      model: 'claude-opus-4-1',
      effort: 'high',
      spend: { tokens: 84_200, windowShare: 0.21 },
      counts: { toolCalls: 18, files: 4, refusals: 1, escalations: 0, children: 5 },
      briefExcerpt: 'Разбери модуль отчётов и почини сборку графиков.',
    }),
    node(ago(11), {
      nodeId: I.explore,
      model: 'claude-haiku-4-5',
      endedAt: ago(8),
      spend: { tokens: 33_500, windowShare: 0.08 },
      counts: { toolCalls: 6, files: 3, refusals: 0, escalations: 0, children: 0 },
      briefExcerpt: 'Найди, где строятся отчёты и кто их вызывает.',
      returnExcerpt: 'Отчёты строятся в src/reports/build.ts, точка входа — renderReport.',
    }),
    node(ago(8), {
      nodeId: I.review,
      model: 'sonnet',
      effort: 'medium',
      status: 'failed',
      endedAt: ago(4),
      spend: { tokens: 44_200, windowShare: 0.11 },
      counts: { toolCalls: 9, files: 2, refusals: 1, escalations: 1, children: 1 },
      briefExcerpt: 'Проверь правки отчётов и прогони тесты модуля.',
      returnExcerpt: 'Сборка упала: модуль chart не найден.',
    }),
    node(ago(7), {
      nodeId: I.tests,
      parentId: I.review,
      model: 'claude-haiku-4-5',
      endedAt: ago(6),
      // Расход вложенного субагента ядру не назван — «неизвестно», а не доля родителя.
      counts: { toolCalls: 2, files: 1, refusals: 0, escalations: 0, children: 0 },
      briefExcerpt: 'Прогони тесты отчётов.',
      returnExcerpt: 'Тесты покрывают таблицу и итоги.',
    }),
    node(ago(5), {
      nodeId: I.bgRunning,
      kind: 'background-shell',
      status: 'running',
      background: true,
      briefExcerpt: 'pnpm dev --port 9123',
    }),
    node(ago(9), {
      nodeId: I.bgDone,
      kind: 'background-shell',
      background: true,
      endedAt: ago(7),
      exitCode: 0,
      briefExcerpt: 'pnpm build',
    }),
    node(ago(10), {
      nodeId: I.bgOrphan,
      parentId: I.review,
      kind: 'background-shell',
      status: 'reaped',
      background: true,
      endedAt: ago(4),
      signals: ['bg-orphan'],
      briefExcerpt: 'pnpm vitest --watch src/reports',
    }),
  ];
}

const CALLS = [
  ['Read', 'src/reports/build.ts', 120, false, false],
  ['Grep', 'renderReport', 80, false, false],
  ['Bash', 'pnpm vitest run src/reports', 4200, true, false],
  ['Write', 'src/reports/chart.ts', 0, null, true],
];

/** Узел подробно: вызовы, файлы, отказы, подъём модели, фон и хвост вывода. */
export function agentHistoryDetail(nodeId, now = Date.now()) {
  const nodes = agentHistoryNodes(now);
  const found = nodes.find((n) => n.nodeId === nodeId) ?? nodes[0];
  const isBg = found.background;
  const bgOf = (n) => ({
    itemId: n.nodeId,
    kind: 'background-shell',
    excerpt: n.briefExcerpt ?? '',
    ownerChain: chain(n.nodeId, n.parentId === SESSION ? null : n.parentId),
    startedAt: n.startedAt,
    ...(n.endedAt !== null ? { endedAt: n.endedAt } : {}),
    ...(n.status === 'reaped' ? { how: 'reaped' } : n.endedAt !== null ? { how: 'exit' } : {}),
    ...(n.exitCode !== undefined ? { exitCode: n.exitCode } : {}),
  });
  const tails = {
    [AGENT_HISTORY_IDS.bgRunning]: '  VITE ready in 812 ms\n  ➜  Local:   http://localhost:9123/',
    [AGENT_HISTORY_IDS.bgDone]: 'built in 14.2s\n✓ 212 modules transformed.',
    [AGENT_HISTORY_IDS.bgOrphan]: ' ✓ src/reports/table.test.ts (6)\n Waiting for file changes...',
  };
  return {
    node: found,
    toolCalls: {
      items: isBg
        ? []
        : CALLS.map(([tool, target, ms, isError, denied], i) => ({
            toolUseId: `toolu_qa_call_${nodeId}_${i}`,
            tool,
            target,
            startedAt: found.startedAt + i * 20_000,
            ms: denied ? null : ms,
            isError: denied ? null : isError,
            denied,
          })),
      next: null,
    },
    files: isBg ? [] : ['src/reports/build.ts', 'src/reports/chart.ts'],
    refusals:
      !isBg && found.counts.refusals > 0
        ? [
            {
              toolUseId: `toolu_qa_call_${nodeId}_3`,
              code: 'grant-required',
              reason: 'Правка src/reports/** — только с разрешением человека.',
            },
          ]
        : [],
    escalations:
      !isBg && found.counts.escalations > 0
        ? [{ from: 'claude-haiku-4-5', to: 'sonnet', cause: 'Два провала тестов подряд.' }]
        : [],
    bg: isBg ? [bgOf(found)] : [],
    outputTail: isBg ? { text: tails[found.nodeId] ?? '', truncated: false } : null,
  };
}

/** План агента в полосе над полем ввода — те же субагенты, что у ядра. */
export function agentHistoryProgress(now = Date.now()) {
  const at = (min) => new Date(now - min * 60_000).toISOString();
  return {
    tasks: [
      { text: 'Разобрать модуль отчётов', status: 'completed' },
      { text: 'Починить сборку графиков', status: 'in_progress' },
      { text: 'Прогнать тесты', status: 'pending' },
    ],
    agents: [
      {
        id: AGENT_HISTORY_IDS.explore,
        kind: 'Explore',
        description: 'Разведка модуля отчётов',
        status: 'done',
        model: 'claude-haiku-4-5',
        toolCalls: 6,
        startedAt: at(11),
        endedAt: at(8),
        result: 'Отчёты строятся в src/reports/build.ts, точка входа — renderReport.',
      },
      {
        id: AGENT_HISTORY_IDS.review,
        kind: 'general-purpose',
        description: 'Ревью правок отчётов',
        status: 'failed',
        model: 'sonnet',
        toolCalls: 9,
        startedAt: at(8),
        endedAt: at(4),
        result: 'Сборка упала: модуль chart не найден.',
      },
      {
        id: AGENT_HISTORY_IDS.tests,
        parentId: AGENT_HISTORY_IDS.review,
        kind: 'Explore',
        description: 'Проверка тестов отчётов',
        status: 'done',
        model: 'claude-haiku-4-5',
        toolCalls: 2,
        startedAt: at(7),
        endedAt: at(6),
      },
    ],
    shells: [
      {
        id: AGENT_HISTORY_IDS.bgRunning,
        command: 'pnpm dev --port 9123',
        status: 'running',
        startedAt: at(5),
      },
    ],
    processAlive: true,
    updatedAt: at(0),
  };
}

const now0 = Date.now();
agentsListReplySchema.parse({ nodes: agentHistoryNodes(now0), truncated: false });
for (const n of agentHistoryNodes(now0))
  agentNodeDetailSchema.parse(agentHistoryDetail(n.nodeId, now0));
chatProgressSchema.parse(agentHistoryProgress(now0));

/**
 * Подменить «Агенты» разговора `AGENT_HISTORY_CHAT` на странице `page`: чат в списке, лента из
 * одного ответа, план агента, узлы ядра и узел подробно; поток дерева сразу кончается (`end`).
 * `projectPath` — путь проекта чата (шапке он нужен), по умолчанию выдуманный.
 */
export async function installAgentHistoryStub(page, { projectPath = 'C:/qa/reports' } = {}) {
  const now = Date.now();
  const chat = {
    id: AGENT_HISTORY_CHAT,
    title: 'Разбери модуль отчётов',
    project: 'reports',
    projectPath,
    isSandbox: false,
    messageCount: 2,
    createdAt: new Date(now - 12 * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    preview: '',
  };
  await page.route('**/api/chats', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [chat] }) : route.continue(),
  );
  await page.route(`**/api/chats/${AGENT_HISTORY_CHAT}/messages*`, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'qa-m-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Разбери модуль отчётов и почини сборку графиков.' }],
            timestamp: new Date(now - 12 * 60_000).toISOString(),
          },
          {
            id: 'qa-m-2',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Раздал разведку и ревью субагентам, сборка идёт в фоне.' },
            ],
            timestamp: new Date(now - 11 * 60_000).toISOString(),
          },
        ],
        total: 2,
        hasMore: false,
      },
    }),
  );
  await page.route(`**/api/chat/${AGENT_HISTORY_CHAT}/progress`, (route) =>
    route.fulfill({ json: agentHistoryProgress(now) }),
  );
  await page.route(/\/api\/core\/agents(\?|$)/, (route) =>
    route.fulfill({ json: { nodes: agentHistoryNodes(now), truncated: false } }),
  );
  await page.route(/\/api\/core\/tasks\/[^/]+\/agents\/stream/, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: end\ndata: {}\n\n',
    }),
  );
  await page.route(/\/api\/core\/tasks\/[^/]+\/agents\/[^/?]+/, (route) => {
    // Последний зарегистрированный обработчик Playwright проверяет первым: поток — не узел.
    const nodeId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    if (nodeId === 'stream') return route.fallback();
    return route.fulfill({ json: agentHistoryDetail(nodeId, now) });
  });
}
