import { describe, expect, it } from 'vitest';
import type { AgentNode, AgentsListReply, AgentTreeView } from '@agentdeck/contracts/core/agents';
import { CORE_ACTIONS, CORE_AGENTS_LIMIT } from './actions-core.ts';

/**
 * Предел списка `core_agents` (ревью W3-19 F-02): модели уходят САМЫЕ НОВЫЕ узлы, в каком бы
 * порядке их ни отдало ядро. Список разговора ядро отдаёт от новых к старым
 * (`apps/core/src/bootstrap/agents-wiring/port.ts`, сортировка по `startedAt` убыванием), дерево
 * задачи — в порядке журнала (от старых). Срез «последних по месту» оставлял от разговора самые
 * старые сто — бегущих сейчас агентов модель не видела.
 */
const TASK = '01900000-0000-7000-8000-000000000001';
const agents = CORE_ACTIONS.find((action) => action.name === 'core_agents')!;

function node(index: number): AgentNode {
  return {
    nodeId: `node-${index}`,
    parentId: null,
    taskId: TASK,
    kind: 'subagent',
    status: 'running',
    stepId: null,
    unitId: null,
    sessionId: null,
    model: 'sonnet',
    background: false,
    startedAt: 1_700_000_000_000 + index * 1000,
    endedAt: null,
    spend: { tokens: null, windowShare: null },
    counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
    signals: [],
    briefExcerpt: null,
    returnExcerpt: null,
  };
}

const COUNT = CORE_AGENTS_LIMIT + 50;
const oldestFirst = Array.from({ length: COUNT }, (_, index) => node(index));
const newestFirst = [...oldestFirst].reverse();
const NEWEST = oldestFirst.slice(-CORE_AGENTS_LIMIT).map((item) => item.nodeId);
const OLDEST = oldestFirst[0]!.nodeId;

const shownIds = (result: unknown): string[] =>
  ((result as { nodes: Array<{ nodeId: string }> }).nodes ?? []).map((item) => item.nodeId);

describe('core_agents: the list limit keeps the newest nodes', () => {
  it('conversation list (core order: newest first) — the newest hundred, the oldest cut', () => {
    const body: AgentsListReply = { nodes: newestFirst, truncated: false };
    const result = agents.shape!({ conversationId: 'conv-1' }, body);
    expect(result).toMatchObject({ total: COUNT, shown: CORE_AGENTS_LIMIT });
    expect(new Set(shownIds(result))).toEqual(new Set(NEWEST));
    expect(shownIds(result)).not.toContain(OLDEST);
  });

  it('task tree (journal order: oldest first) — the same newest hundred', () => {
    const body = { taskId: TASK, seq: 1, class: null, nodes: oldestFirst } as AgentTreeView;
    const result = agents.shape!({ taskId: TASK }, body);
    expect(result).toMatchObject({ taskId: TASK, total: COUNT, shown: CORE_AGENTS_LIMIT });
    expect(new Set(shownIds(result))).toEqual(new Set(NEWEST));
  });

  it('newest first in the answer, unknown spend stays null (never zero)', () => {
    const body: AgentsListReply = { nodes: oldestFirst.slice(0, 3), truncated: false };
    const result = agents.shape!({ conversationId: 'conv-1' }, body) as {
      nodes: Array<{ nodeId: string; spend: unknown }>;
    };
    expect(result.nodes.map((item) => item.nodeId)).toEqual(['node-2', 'node-1', 'node-0']);
    expect(result.nodes.map((item) => item.spend)).toEqual(
      Array.from({ length: 3 }, () => ({ tokens: null, windowShare: null })),
    );
  });
});
