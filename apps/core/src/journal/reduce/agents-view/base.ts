import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { TASK_CLASSES, type TaskClass } from '@agentdeck/contracts/core/scenario';
import type { AgentsFold, NodeAcc } from '../agents-view.types.ts';

/**
 * Основа свёртки истории агентов: срез видов строк, мера токенов, пустая свёртка, новый узел и узел
 * контекста вызова — общее для вызовов (`calls.ts`) и жизни узлов (`lifecycle.ts`).
 */

/** Виды строк, которые читает свёртка, — они же срез выгрузки `…/agents/export`. */
export const AGENT_SLICE_KINDS: readonly JournalKind[] = [
  'task.created',
  'task.ended',
  'step.started',
  'session.started',
  'session.transition',
  'turn.usage',
  'tool.started',
  'tool.event',
  'agent.spawned',
  'agent.ended',
  'bg.started',
  'bg.ended',
  'decision',
  'signal',
];

/**
 * Токены бюджета строки расхода — та же мера, что у истории оценки (`economy/cost.budgetTokens`:
 * вход + запись кэша + выход): чтение кэша — перенос контекста, не работа.
 */
export function usageTokens(u: { input: number; cacheWrite: number; output: number }): number {
  return u.input + u.cacheWrite + u.output;
}

export function initAgentsFold(taskId: string): AgentsFold {
  return {
    taskId,
    seq: 0,
    class: null,
    groupId: null,
    conversationId: null,
    taskEnded: false,
    nodes: new Map(),
    calls: new Map(),
    sessions: new Map(),
    steps: new Map(),
    escalations: new Map(),
    lastRung: new Map(),
    pending: new Map(),
    early: new Map(),
    strays: new Map(),
    decided: new Set(),
  };
}

export const data = <K extends JournalKind>(l: JournalLine, _k: K) => (l as JournalLine<K>).data;
export const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
export const isClass = (v: unknown): v is TaskClass =>
  typeof v === 'string' && (TASK_CLASSES as readonly string[]).includes(v);

export function node(
  fold: AgentsFold,
  init: Omit<
    NodeAcc,
    | 'usage'
    | 'calls'
    | 'files'
    | 'refusals'
    | 'signals'
    | 'endTokens'
    | 'windowShare'
    | 'endedAt'
    | 'status'
  >,
): NodeAcc {
  const n: NodeAcc = {
    ...init,
    status: 'running',
    endedAt: null,
    usage: new Map(),
    endTokens: null,
    windowShare: null,
    calls: [],
    files: [],
    refusals: [],
    signals: [],
  };
  fold.nodes.set(n.nodeId, n);
  return n;
}

/** Узел контекста вызова: субагент по `parentToolUseId`, иначе — сеанс. */
export function contextNode(
  fold: AgentsFold,
  sessionId: string,
  parent: string | null | undefined,
) {
  const sub = parent ? fold.nodes.get(parent) : undefined;
  return sub && sub.sessionId === sessionId && !sub.bg ? sub : fold.nodes.get(sessionId);
}
