import { z } from 'zod';
import {
  AGENT_STATUSES,
  type AgentNode,
  type AgentNodeDetail,
  type AgentsListReply,
  type AgentTreeView,
} from '@agentdeck/contracts/core/agents';
import { CORE_ECONOMY_DEFAULTS, type ConfigView } from '@agentdeck/contracts/core/config';
import type { ReportReply, TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import { definePanelAction, type AnyPanelAction } from '../registry.ts';

/**
 * Ядро задач для агента панели (этап 11, P151) — только чтение и только то, что нужно ведущему:
 * список задач, одна задача (хвост ленты и вопросы, ждущие человека), итоговый отчёт, настройки
 * ведущего и агенты задач (W3-19). Всё — через прокладку панели `/api/core/*`: токен ядра остаётся у сервера и до модели
 * не доходит. Команды задаче, оценка (она СОЗДАЁТ задачу), запись настройки и сценариев — кнопки
 * человека (`human:rights` в реестре возможностей). На вопрос ядра агент не отвечает: он может
 * только открыть человеку страницу задачи, где вопрос и ответ.
 */

/** Сколько последних шагов и решений ленты уходит модели: вид задачи растёт весь прогон. */
export const CORE_TIMELINE_TAIL = 12;
/** Сколько задач в списке: модель читает его каждый ход. */
export const CORE_TASKS_LIMIT = 100;

const taskId = z.uuid().describe('Core task id (taskId) from core_tasks');

const coreTasks = definePanelAction({
  name: 'core_tasks',
  section: 'core',
  risk: 'read',
  description:
    'List tasks of the execution core: id, title, state, whether it runs now, what waits for ' +
    'the human. Read-only; commands to a task (launch, pause, answer) are the human’s buttons.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/core/tasks' }),
  shape: (_input, body) => {
    const { tasks } = body as TasksReply;
    return {
      total: tasks.length,
      tasks: tasks.slice(-CORE_TASKS_LIMIT).map((task) => ({
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        ended: task.ended,
        live: task.live,
        attention: task.attention,
      })),
    };
  },
  summary: 'journal-core-tasks',
});

/** Поля вида задачи, которые добавляет этап 11 (класс, профиль, группа, ожидание слота). */
const LEAD_VIEW_FIELDS = ['class', 'profile', 'groupId', 'waiting'] as const;

function taskShape(body: unknown): Record<string, unknown> {
  const { live, view } = body as TaskReply;
  const extra = view as unknown as Partial<Record<(typeof LEAD_VIEW_FIELDS)[number], unknown>>;
  const lead = Object.fromEntries(
    LEAD_VIEW_FIELDS.filter((key) => extra[key] !== undefined).map((key) => [key, extra[key]]),
  );
  const open = view.asks.filter((ask) => ask.state === 'open');
  return {
    taskId: view.taskId,
    state: view.state,
    ended: view.ended,
    live,
    attention: view.attention,
    ...lead,
    scenario: view.scenario?.ref ?? null,
    split: view.split ? { state: view.split.state, units: view.split.units.length } : null,
    // Вопрос ждёт человека: ответ — только его кнопка на странице задачи (`human-strict` ядра).
    pendingAsks: open.map((ask) => ({
      askId: ask.askId,
      point: ask.point,
      source: ask.source,
      // Ключ вопроса — как в виде задачи: карточка приёма и прочие вопросы ведущего различимы.
      dedupe: ask.dedupe,
      stepId: ask.stepId,
    })),
    closedAsks: view.asks.length - open.length,
    timeline: {
      steps: view.steps.length,
      checks: view.checks.length,
      lastSteps: view.steps.slice(-CORE_TIMELINE_TAIL).map((step) => ({
        stepId: step.stepId,
        kind: step.stepKind,
        round: step.round,
        state: step.state,
        outcome: step.outcome,
        reason: step.reason,
      })),
      lastChecks: view.checks.slice(-CORE_TIMELINE_TAIL).map((check) => ({
        stepId: check.stepId,
        mode: check.mode,
        why: check.why,
        recordId: check.recordId,
      })),
    },
    sessions: view.sessions.length,
    spend: { usd: view.spend.cost.usd, turns: view.spend.tokens.turns },
    report: view.report ? { at: view.report.at } : null,
  };
}

const coreTask = definePanelAction({
  name: 'core_task',
  section: 'core',
  risk: 'read',
  description:
    'One core task: state, the last steps and check decisions of its feed (with why), and the ' +
    'questions waiting for the human. You never answer a question: set open=true to show the ' +
    'task page on the human’s screen, where the human answers it.',
  input: z.object({
    taskId,
    open: z
      .boolean()
      .optional()
      .describe('Also open this task’s page for the human (questions are answered there)'),
  }),
  route: (input) => ({ method: 'GET', url: `/api/core/tasks/${encodeURIComponent(input.taskId)}` }),
  shape: (_input, body) => taskShape(body),
  // Страница задачи открывается только по просьбе: чтение не уводит человека со своей страницы.
  page: (input) =>
    input.open ? { route: `/core?id=${encodeURIComponent(input.taskId)}` } : undefined,
  summary: 'journal-core-task',
});

const coreReport = definePanelAction({
  name: 'core_report',
  section: 'core',
  risk: 'read',
  description:
    'Final report of a finished core task: outcome, units, requirements, forks, unverified ' +
    'items, residuals, suggestions. A task without a report answers that it has none.',
  input: z.object({ taskId }),
  route: (input) => ({
    method: 'GET',
    url: `/api/core/tasks/${encodeURIComponent(input.taskId)}/report`,
  }),
  shape: (_input, body) => {
    const { taskId: id, ref, report } = body as ReportReply;
    return { taskId: id, at: ref.at, report };
  },
  summary: 'journal-core-report',
});

/**
 * Разделы настройки ядра, которые читает ведущий. Прочие (маршруты моделей со скриптами
 * заглушек и адресами серверов, пути CLI, маски чтения, гранты, доверие репозиториям, выбор MCP,
 * опрос форжа) модели не уходят вовсе: ей они не нужны, а в адресе сервера бывает ключ.
 */
export const LEAD_CONFIG_SECTIONS = ['lead', 'economy', 'queue', 'humanPoints'] as const;

function leadSettingsShape(body: unknown): Record<string, unknown> {
  const view = body as ConfigView;
  const doc = view.doc as Partial<Record<(typeof LEAD_CONFIG_SECTIONS)[number], unknown>>;
  const wanted = new Set<string>(LEAD_CONFIG_SECTIONS);
  return {
    // Нет раздела — ведущий берёт умолчания профиля ядра.
    lead: doc.lead ?? null,
    // Как карточка «Экономия» настроек: умолчания ядра, перекрытые записанным.
    economy: { ...CORE_ECONOMY_DEFAULTS, ...(view.doc.economy ?? {}) },
    queue: doc.queue ?? null,
    humanPoints: doc.humanPoints ?? null,
    // Файл правлен мимо API — записанное не действует, пока человек не подтвердит.
    drift: view.drift ? { sections: view.drift.sections.filter((s) => wanted.has(s)) } : null,
    issues: view.issues.filter((issue) => wanted.has(issue.section)),
  };
}

const coreLeadSettings = definePanelAction({
  name: 'core_lead_settings',
  section: 'core',
  risk: 'read',
  description:
    'Lead settings of the core: lead profile and per-project overrides, economy levers ' +
    '(defaults merged with what is set), queue slots, human points. Read-only: the settings ' +
    'are changed only by the human in the panel.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/core/config' }),
  shape: (_input, body) => leadSettingsShape(body),
  summary: 'journal-core-lead-settings',
});

/** Сколько узлов списка уходит модели (самые новые): у разговора их бывают сотни. */
export const CORE_AGENTS_LIMIT = 100;
/** Сколько вызовов узла и его файлов уходит модели с первой страницы ядра. */
export const CORE_AGENT_CALLS_LIMIT = 40;
export const CORE_AGENT_FILES_LIMIT = 100;

/** Строка узла для модели: без отрывков поручения и ответа — они в подробностях узла. */
function agentRow(node: AgentNode): Record<string, unknown> {
  return {
    nodeId: node.nodeId,
    parentId: node.parentId,
    taskId: node.taskId,
    kind: node.kind,
    status: node.status,
    model: node.model,
    ...(node.effort ? { effort: node.effort } : {}),
    background: node.background,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    // `null` — неизвестно (ядро не узнало расход), никогда не ноль.
    spend: node.spend,
    counts: node.counts,
    ...(node.signals.length > 0 ? { signals: node.signals } : {}),
    ...(node.exitCode !== undefined ? { exitCode: node.exitCode } : {}),
  };
}

/**
 * Самые новые узлы первыми — по времени старта, а не по порядку ответа: список разговора ядро
 * отдаёт от новых к старым (`agents-wiring/port.ts`), дерево задачи — в порядке журнала. Срез
 * «последних по месту» оставлял от разговора самые СТАРЫЕ сто (ревью W3-19 F-02).
 */
function agentRows(nodes: readonly AgentNode[]): Record<string, unknown> {
  const newest = [...nodes].sort((a, b) => b.startedAt - a.startedAt);
  return {
    total: nodes.length,
    shown: Math.min(nodes.length, CORE_AGENTS_LIMIT),
    nodes: newest.slice(0, CORE_AGENTS_LIMIT).map(agentRow),
  };
}

function agentDetailShape(body: unknown): Record<string, unknown> {
  const detail = body as AgentNodeDetail;
  return {
    node: {
      ...agentRow(detail.node),
      briefExcerpt: detail.node.briefExcerpt,
      returnExcerpt: detail.node.returnExcerpt,
    },
    toolCalls: {
      shown: Math.min(detail.toolCalls.items.length, CORE_AGENT_CALLS_LIMIT),
      onPage: detail.toolCalls.items.length,
      more: detail.toolCalls.next !== null,
      items: detail.toolCalls.items.slice(0, CORE_AGENT_CALLS_LIMIT),
    },
    files: {
      total: detail.files.length,
      items: detail.files.slice(0, CORE_AGENT_FILES_LIMIT),
    },
    refusals: detail.refusals,
    escalations: detail.escalations,
    background: detail.bg.map((item) => ({
      itemId: item.itemId,
      kind: item.kind,
      excerpt: item.excerpt,
      startedAt: item.startedAt,
      ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
      ...(item.how ? { how: item.how } : {}),
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
    })),
    outputTail: detail.outputTail,
  };
}

const agentsInput = z
  .object({
    conversationId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Chat id (from list_chats): every agent of every core task of that chat'),
    taskId: taskId.optional(),
    nodeId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Node id from the list, with its taskId: calls, files, refusals, background, output',
      ),
    status: z.enum(AGENT_STATUSES).optional().describe('Only nodes in this status (lists only)'),
  })
  .refine((input) => Boolean(input.conversationId) !== Boolean(input.taskId), {
    message: 'Give conversationId or taskId (one of them)',
  })
  .refine((input) => !input.nodeId || Boolean(input.taskId), {
    message: 'nodeId needs the taskId of its node',
  });

/** Строка запроса списка: только названный фильтр, пустая — без `?` значений. */
function agentsQuery(input: z.infer<typeof agentsInput>): string {
  const query = new URLSearchParams();
  if (input.conversationId) query.set('conversationId', input.conversationId);
  if (input.status) query.set('status', input.status);
  return query.toString();
}

/**
 * Агенты ядра (этап 11, W3-19): дерево сеансов, субагентов и фоновых работ — свёртка журнала ядра,
 * транскрипты CLI не читаются. Разговор чата (все его задачи), одна задача или один узел подробно.
 * Выгрузка журнала об агентах (`…/agents/export`) — файл для человека (`human:download`), поток —
 * окну; ни то ни другое действие не зовёт.
 */
const coreAgents = definePanelAction({
  name: 'core_agents',
  section: 'core',
  risk: 'read',
  description:
    'Agents of the execution core: unit sessions, subagents and background work (shells, ' +
    'monitors, servers) with model, status, spend (null = unknown, never zero), counts and ' +
    'signals such as bg-orphan. Give conversationId (a chat id) for every agent of that chat, ' +
    'or taskId for one task’s tree; add nodeId (with its taskId) for one node in detail. ' +
    'Read-only: stopping an agent is the human’s.',
  input: agentsInput,
  route: (input) => {
    const query = agentsQuery(input);
    if (input.taskId && input.nodeId) {
      return {
        method: 'GET',
        url: `/api/core/tasks/${encodeURIComponent(input.taskId)}/agents/${encodeURIComponent(input.nodeId)}`,
      };
    }
    if (input.taskId) {
      return {
        method: 'GET',
        url: `/api/core/tasks/${encodeURIComponent(input.taskId)}/agents?${query}`,
      };
    }
    return { method: 'GET', url: `/api/core/agents?${query}` };
  },
  shape: (input, body) => {
    if (input.nodeId) return agentDetailShape(body);
    if (input.taskId) {
      const tree = body as AgentTreeView;
      return { taskId: tree.taskId, class: tree.class, ...agentRows(tree.nodes) };
    }
    const list = body as AgentsListReply;
    // Ядро обрезало список своим пределом — показаны самые новые.
    return {
      conversationId: input.conversationId,
      truncated: list.truncated,
      ...agentRows(list.nodes),
    };
  },
  summary: 'journal-core-agents',
});

export const CORE_ACTIONS: readonly AnyPanelAction[] = [
  coreTasks,
  coreTask,
  coreReport,
  coreLeadSettings,
  coreAgents,
];
