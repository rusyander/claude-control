import { z } from 'zod';
import { uuidv7 } from './ids.ts';
import { TASK_CLASSES } from './scenario.ts';

/**
 * История агентов задачи (этап 11, P146-P149): дерево сеансов единиц, субагентов и фоновых работ —
 * ТОЛЬКО свёртка журнала (`agent.spawned`/`agent.ended`, `bg.started`/`bg.ended`, `tool.started`,
 * `turn.usage.parentToolUseId`), транскрипты CLI вид не читает. Расход узла неизвестен — `null`
 * («неизвестно»), никогда не `0`. Дерево плоское: узел ссылается на родителя по `parentId`.
 */

const line = (max: number) => z.string().min(1).max(max);
const nonNeg = z.number().int().nonnegative();
const toolUseId = z.string().min(1).max(256);

export const AGENT_KINDS = [
  'unit-session',
  'subagent',
  'background-shell',
  'monitor',
  'server',
  'long-tool',
  'other',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Фоновые виды: их пишет `bg.started`; сеанс единицы и субагент — свои строки журнала. */
export const BG_KINDS = ['background-shell', 'monitor', 'server', 'long-tool', 'other'] as const;
export type BgKind = (typeof BG_KINDS)[number];

/** Как кончился субагент (`agent.ended.how`). */
export const AGENT_END_HOWS = ['completed', 'failed', 'killed', 'stopped', 'lost'] as const;
export type AgentEndHow = (typeof AGENT_END_HOWS)[number];
/** Как кончилась фоновая работа (`bg.ended.how`); `reaped` — её снесла уборка после владельца. */
export const BG_END_HOWS = ['exit', 'failed', 'killed', 'stopped', 'reaped', 'lost'] as const;
export type BgEndHow = (typeof BG_END_HOWS)[number];

/** Состояние узла: идёт или как кончился (фоновый `exit` показан как `completed`). */
export const AGENT_STATUSES = [
  'running',
  'completed',
  'failed',
  'killed',
  'stopped',
  'reaped',
  'lost',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Кто владеет фоновой работой — цепочка до вызова, который её запустил (P148). */
export const ownerChainSchema = z.strictObject({
  taskId: uuidv7,
  stepId: uuidv7,
  unitId: uuidv7.nullable(),
  sessionId: uuidv7,
  toolUseId,
  parentToolUseId: toolUseId.nullable(),
});
export type OwnerChain = z.infer<typeof ownerChainSchema>;

export const bgItemSchema = z.strictObject({
  itemId: line(256),
  kind: z.enum(BG_KINDS),
  /** Начало команды или описания (замаскировано), не весь текст. */
  excerpt: z.string().max(500),
  ownerChain: ownerChainSchema,
  pid: z.number().int().positive().optional(),
  /** Файл вывода CLI: хвост читается при показе, в журнал не пишется (P148). */
  outputFile: line(1000).optional(),
  startedAt: nonNeg,
  endedAt: nonNeg.optional(),
  how: z.enum(BG_END_HOWS).optional(),
  /** Код выхода из `bg.ended.exitCode`; нет — CLI его не назвал или работа ещё идёт. */
  exitCode: z.number().int().optional(),
});
export type BgItem = z.infer<typeof bgItemSchema>;

/** Расход узла: токены и доля окна; `null` — неизвестно (P146), не ноль. */
export const agentSpendSchema = z.strictObject({
  tokens: nonNeg.nullable(),
  windowShare: z.number().min(0).max(1).nullable(),
});

export const agentNodeSchema = z.strictObject({
  /** Сеанс — его `sessionId`, субагент — `toolUseId` вызова, фоновая работа — `itemId`. */
  nodeId: line(256),
  parentId: line(256).nullable(),
  taskId: uuidv7,
  kind: z.enum(AGENT_KINDS),
  status: z.enum(AGENT_STATUSES),
  stepId: uuidv7.nullable(),
  unitId: uuidv7.nullable(),
  sessionId: uuidv7.nullable(),
  /** `null` — модель не названа (CLI по умолчанию или фоновая работа). */
  model: z.string().min(1).max(200).nullable(),
  effort: z.string().min(1).max(200).nullable().optional(),
  background: z.boolean(),
  startedAt: nonNeg,
  endedAt: nonNeg.nullable(),
  spend: agentSpendSchema,
  counts: z.strictObject({
    toolCalls: nonNeg,
    files: nonNeg,
    refusals: nonNeg,
    escalations: nonNeg,
    children: nonNeg,
  }),
  /** Ид сигналов наблюдателя на этом узле (`bg-orphan`, `bg-hang`, …). */
  signals: z.array(line(100)).max(50),
  briefExcerpt: z.string().max(2000).nullable(),
  returnExcerpt: z.string().max(2000).nullable(),
  /** Код выхода фоновой работы (`bg.ended.exitCode`): строка «завершён (код 0)» без запроса узла. */
  exitCode: z.number().int().optional(),
});
export type AgentNode = z.infer<typeof agentNodeSchema>;

export const agentTreeViewSchema = z.strictObject({
  taskId: uuidv7,
  /** Последняя строка журнала в свёртке: курсор потока `?after=`. */
  seq: nonNeg,
  class: z.enum(TASK_CLASSES).nullable(),
  nodes: z.array(agentNodeSchema),
});
export type AgentTreeView = z.infer<typeof agentTreeViewSchema>;

/** Строка вызова инструмента узла (`tool.started` + `tool.event` того же `toolUseId`). */
export const agentToolCallSchema = z.strictObject({
  toolUseId,
  tool: line(256),
  target: z.string().max(2000),
  startedAt: nonNeg.nullable(),
  /** `null` — вызов ещё идёт (есть `tool.started`, нет `tool.event`). */
  ms: nonNeg.nullable(),
  isError: z.boolean().nullable(),
  denied: z.boolean(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** Подробно об узле: вызовы постранично, файлы, отказы права, подъёмы с причиной, фон и хвост. */
export const agentNodeDetailSchema = z.strictObject({
  node: agentNodeSchema,
  toolCalls: z.strictObject({
    items: z.array(agentToolCallSchema).max(500),
    /** Курсор следующей страницы; `null` — страниц больше нет. */
    next: z.string().min(1).max(200).nullable(),
  }),
  files: z.array(line(1000)).max(1000),
  refusals: z.array(z.strictObject({ toolUseId, code: line(200), reason: z.string().max(2000) })),
  escalations: z.array(
    z.strictObject({ from: line(200), to: line(200), cause: z.string().max(2000) }),
  ),
  bg: z.array(bgItemSchema),
  /** Хвост файла вывода фоновой работы, замаскированный при показе; `null` — нет файла. */
  outputTail: z.strictObject({ text: z.string(), truncated: z.boolean() }).nullable(),
});
export type AgentNodeDetail = z.infer<typeof agentNodeDetailSchema>;

/**
 * Фильтры списка агентов (`GET /v1/tasks/:id/agents`, `GET /v1/agents`): значения — строки
 * запроса; `groupId` и `conversationId` — только у списка всех задач.
 */
export const agentsQuerySchema = z.strictObject({
  status: z.enum(AGENT_STATUSES).optional(),
  model: z.string().min(1).max(200).optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  class: z.enum(TASK_CLASSES).optional(),
  groupId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
});
export type AgentsQuery = z.infer<typeof agentsQuerySchema>;

export const agentsListReplySchema = z.strictObject({
  nodes: z.array(agentNodeSchema),
  /** Список обрезан пределом ответа: показаны самые новые. */
  truncated: z.boolean(),
});
export type AgentsListReply = z.infer<typeof agentsListReplySchema>;

/**
 * Кадр потока `GET /v1/tasks/:id/agents/stream` (SSE, id события = `seq`): первый — снимок
 * дерева, дальше — изменённый узел; `end` — задача кончилась, поток закрыт ядром.
 */
export const agentsStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot'), view: agentTreeViewSchema }),
  z.strictObject({ type: z.literal('node'), seq: nonNeg, node: agentNodeSchema }),
  z.strictObject({ type: z.literal('end'), seq: nonNeg }),
]);
export type AgentsStreamEvent = z.infer<typeof agentsStreamEventSchema>;
