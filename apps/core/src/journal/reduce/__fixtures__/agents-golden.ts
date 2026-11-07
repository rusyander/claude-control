import type { AgentNode } from '@agentdeck/contracts/core/agents';
import type { JournalKind } from '@agentdeck/contracts/core/journal';

/**
 * Золотой журнал истории агентов (этап 11, P146-P149) — строки ровно той формы, какой их пишет
 * переходник CLI зоны I1 (`tool.started`, `agent.spawned`/`agent.ended`, `bg.*`,
 * `turn.usage.parentToolUseId`), после начала сессии шага. В конце волны родитель заменяет их
 * записанными строками I1 — меняется только этот файл, тест свёртки остаётся.
 *
 * Сюжет: главный контекст читает файл и зовёт субагента (модель `sonnet`); субагент ищет и
 * тратит 500 токенов бюджета (строка его сообщения пришла дважды — повтор заменяет); строка
 * расхода называет вызов `toolu_ghost`, которого сессия не запускала, — ничей расход; второй
 * субагент кончается без итога — расход неизвестен (`null`); фоновая оболочка начинается и
 * кончается; сессия выходит, задача кончается.
 */

export interface GoldenIds {
  taskId: string;
  stepId: string;
  unitId: string;
  sessionId: string;
}

export interface GoldenRow {
  kind: JournalKind;
  sessionId?: string;
  stepId?: string;
  data: unknown;
}

export const SUB = 'toolu_01SubAgent';
export const SUB_UNKNOWN = 'toolu_02SubNoUsage';
export const GHOST = 'toolu_ghost';
export const BG_ITEM = 'bash_bg_1';
/** Путь, который маска журнала обязана пропустить как есть (U4: временный каталог с цифрой). */
export const TEMP_FILE = 'C:/Users/u/AppData/Local/Temp/cc-t3-x9/src/a.ts';
export const OUTPUT_FILE = 'C:/Users/u/AppData/Local/Temp/claude/tasks/bash_bg_1.output';

const usageRow = (
  ids: GoldenIds,
  messageId: string,
  n: { input: number; cacheRead: number; cacheWrite: number; output: number },
  parentToolUseId: string | null,
  contextWindow?: number,
): GoldenRow => ({
  kind: 'turn.usage',
  sessionId: ids.sessionId,
  data: {
    sessionId: ids.sessionId,
    messageId,
    ...n,
    cacheWrite1h: 0,
    routeId: 'stub-1',
    model: parentToolUseId ? 'sonnet' : 'model-a',
    subagent: parentToolUseId !== null,
    parentSessionId: null,
    remainder: false,
    ...(contextWindow ? { contextWindow } : {}),
    parentToolUseId,
  },
});

const started = (
  ids: GoldenIds,
  toolUseId: string,
  tool: string,
  target: string,
  parent: string | null = null,
): GoldenRow => ({
  kind: 'tool.started',
  sessionId: ids.sessionId,
  data: { sessionId: ids.sessionId, toolUseId, parentToolUseId: parent, tool, target },
});

const event = (
  ids: GoldenIds,
  toolUseId: string,
  tool: string,
  effectClass: string,
  target: string,
  parent: string | null = null,
): GoldenRow => ({
  kind: 'tool.event',
  sessionId: ids.sessionId,
  data: {
    sessionId: ids.sessionId,
    toolUseId,
    parentToolUseId: parent,
    tool,
    effectClass,
    target,
    argvDigest: null,
    cwd: null,
    range: null,
    fileFp: null,
    sizeBytes: null,
    isError: false,
    exitCode: null,
    errorDigest: null,
    ms: 12,
  },
});

const spawned = (ids: GoldenIds, toolUseId: string, model: string | null): GoldenRow => ({
  kind: 'agent.spawned',
  sessionId: ids.sessionId,
  data: {
    sessionId: ids.sessionId,
    toolUseId,
    parentToolUseId: null,
    cliTaskId: `cli-${toolUseId}`,
    kind: 'subagent',
    subagentType: 'general-purpose',
    model,
    effort: null,
    background: false,
    depth: 1,
    briefExcerpt: `Brief of ${toolUseId}`,
  },
});

const ended = (
  ids: GoldenIds,
  toolUseId: string,
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null,
): GoldenRow => ({
  kind: 'agent.ended',
  sessionId: ids.sessionId,
  data: {
    sessionId: ids.sessionId,
    toolUseId,
    cliTaskId: `cli-${toolUseId}`,
    how: 'completed',
    usage,
    summaryExcerpt: usage ? 'Found the config' : null,
  },
});

/** Строки после начала сессии шага (`step.started` + `session.started` пишет вызывающий). */
export function agentsGoldenRows(ids: GoldenIds): GoldenRow[] {
  return [
    started(ids, 'toolu_read', 'Read', TEMP_FILE),
    event(ids, 'toolu_read', 'Read', 'read', TEMP_FILE),
    usageRow(
      ids,
      'm-1',
      { input: 1000, cacheRead: 5000, cacheWrite: 200, output: 300 },
      null,
      200_000,
    ),
    started(ids, SUB, 'Agent', 'Find the config'),
    spawned(ids, SUB, 'sonnet'),
    started(ids, 'toolu_grep', 'Grep', 'config/', SUB),
    event(ids, 'toolu_grep', 'Grep', 'read', 'config/', SUB),
    usageRow(ids, 'm-2', { input: 400, cacheRead: 9000, cacheWrite: 0, output: 100 }, SUB),
    // Повтор того же сообщения субагента (поток CLI шлёт его дважды) — заменяет, не прибавляет.
    usageRow(ids, 'm-2', { input: 400, cacheRead: 9000, cacheWrite: 0, output: 100 }, SUB),
    // Вызов, которого сессия не запускала: ни родителю, ни субагенту.
    usageRow(ids, 'm-3', { input: 7000, cacheRead: 0, cacheWrite: 0, output: 700 }, GHOST),
    ended(ids, SUB, { totalTokens: 9_999, toolUses: 1, durationMs: 4000 }),
    event(ids, SUB, 'Agent', 'other', 'Find the config'),
    started(ids, 'toolu_bash', 'Bash', 'npm run watch'),
    {
      kind: 'bg.started',
      sessionId: ids.sessionId,
      data: {
        itemId: BG_ITEM,
        kind: 'background-shell',
        excerpt: 'npm run watch',
        ownerChain: {
          taskId: ids.taskId,
          stepId: ids.stepId,
          unitId: ids.unitId,
          sessionId: ids.sessionId,
          toolUseId: 'toolu_bash',
          parentToolUseId: null,
        },
        outputFile: OUTPUT_FILE,
        startedAt: 1_700_000_000_000,
      },
    },
    spawned(ids, SUB_UNKNOWN, null),
    ended(ids, SUB_UNKNOWN, null),
    {
      kind: 'bg.ended',
      data: { itemId: BG_ITEM, how: 'exit', exitCode: 0, endedAt: 1_700_000_005_000 },
    },
    usageRow(ids, 'm-4', { input: 900, cacheRead: 6000, cacheWrite: 0, output: 100 }, null),
    {
      kind: 'session.transition',
      sessionId: ids.sessionId,
      data: { sessionId: ids.sessionId, event: 'exited', from: 'live', to: 'ended' },
    },
  ];
}

/** Узел без времён: их ставит журнал (`at`), золото сравнивает всё остальное. */
export type TimelessNode = Omit<AgentNode, 'startedAt' | 'endedAt'>;

const counts = (c: Partial<AgentNode['counts']> = {}): AgentNode['counts'] => ({
  toolCalls: 0,
  files: 0,
  refusals: 0,
  escalations: 0,
  children: 0,
  ...c,
});

/**
 * Дерево по золотому журналу. Главный контекст: 1500 (m-1) + 1000 (m-4) = 2500 токенов бюджета —
 * ни 500 субагента, ни 7700 чужого вызова к нему не прибавлены (P149). Субагент: 500 из его строк
 * (строки главнее итога CLI 9999). Второй субагент без строк и без итога — `null`.
 */
export function agentsGoldenTree(ids: GoldenIds, sessionModel = 'model-a'): TimelessNode[] {
  const base = {
    taskId: ids.taskId,
    stepId: ids.stepId,
    unitId: ids.unitId,
    sessionId: ids.sessionId,
    effort: null,
    signals: [],
  };
  return [
    {
      ...base,
      nodeId: ids.sessionId,
      parentId: null,
      kind: 'unit-session',
      status: 'completed',
      model: sessionModel,
      background: false,
      spend: { tokens: 2500, windowShare: 6200 / 200_000 },
      counts: counts({ toolCalls: 3, files: 1, children: 3 }),
      briefExcerpt: null,
      returnExcerpt: null,
    },
    {
      ...base,
      nodeId: SUB,
      parentId: ids.sessionId,
      kind: 'subagent',
      status: 'completed',
      model: 'sonnet',
      background: false,
      spend: { tokens: 500, windowShare: null },
      counts: counts({ toolCalls: 1, files: 1 }),
      briefExcerpt: `Brief of ${SUB}`,
      returnExcerpt: 'Found the config',
    },
    {
      ...base,
      nodeId: BG_ITEM,
      parentId: ids.sessionId,
      kind: 'background-shell',
      status: 'completed',
      model: null,
      background: true,
      spend: { tokens: null, windowShare: null },
      counts: counts(),
      briefExcerpt: 'npm run watch',
      returnExcerpt: null,
      exitCode: 0,
    },
    {
      ...base,
      nodeId: SUB_UNKNOWN,
      parentId: ids.sessionId,
      kind: 'subagent',
      status: 'completed',
      model: null,
      background: false,
      spend: { tokens: null, windowShare: null },
      counts: counts(),
      briefExcerpt: `Brief of ${SUB_UNKNOWN}`,
      returnExcerpt: null,
    },
  ];
}

/** Узлы вида без времён — для сравнения с золотом. */
export function timeless(nodes: readonly AgentNode[]): TimelessNode[] {
  return nodes.map(({ startedAt: _s, endedAt: _e, ...rest }) => rest);
}
