import { describe, expect, it } from 'vitest';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import {
  agentsQuery,
  buildCoreTree,
  lookText,
  nodeLook,
  ownerOf,
  ownerPool,
  runningBackground,
  workerNodes,
} from './coreAgents';

/**
 * Агенты чата по журналу ядра: счёт «фоном: N», дерево из плоского списка и слово состояния —
 * в том числе «осиротел — потерян» для фоновой работы, чей владелец кончился аварийно.
 */
const TASK = '019a0000-0000-7000-8000-000000000001';

const node = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
  nodeId,
  parentId: 'sess',
  taskId: TASK,
  kind: 'subagent',
  status: 'completed',
  stepId: null,
  unitId: null,
  sessionId: null,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 2_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: null,
  returnExcerpt: null,
  ...over,
});

const session = (over: Partial<AgentNode> = {}) =>
  node('sess', { kind: 'unit-session', parentId: null, ...over });
const bg = (nodeId: string, over: Partial<AgentNode> = {}) =>
  node(nodeId, { kind: 'background-shell', background: true, ...over });

describe('runningBackground — число на карточке «фоном: N»', () => {
  it('считает идущие фоновые работы и фоновых субагентов, законченное и передний план — нет', () => {
    const nodes = [
      session({ status: 'running', endedAt: null }),
      bg('b1', { status: 'running', endedAt: null }),
      bg('b2', { status: 'completed' }),
      node('s1', { background: true, status: 'running', endedAt: null }),
      node('s2', { status: 'running', endedAt: null }),
    ];
    expect(runningBackground(nodes)).toBe(2);
  });

  it('фоновых нет — ноль', () => {
    expect(runningBackground([session({ status: 'running' }), node('s1')])).toBe(0);
  });
});

describe('buildCoreTree — дерево из плоского списка', () => {
  it('детей кладёт под родителя по порядку запуска, уровни считает', () => {
    const roots = buildCoreTree([
      session(),
      bg('b1', { startedAt: 5_000 }),
      node('s1', { startedAt: 3_000 }),
      bg('b2', { parentId: 's1', startedAt: 4_000 }),
    ]);
    expect(roots.map((r) => r.node.nodeId)).toEqual(['sess']);
    expect(roots[0]!.children.map((c) => c.node.nodeId)).toEqual(['s1', 'b1']);
    expect(roots[0]!.children[0]!.children[0]!.node.nodeId).toBe('b2');
    expect(roots[0]!.children[0]!.children[0]!.level).toBe(2);
  });

  it('родителя нет в ответе — узел становится корнем, а не пропадает', () => {
    const roots = buildCoreTree([node('s1', { parentId: 'gone' }), session()]);
    expect(roots.map((r) => r.node.nodeId).sort()).toEqual(['s1', 'sess']);
  });

  it('родитель из другой задачи с тем же id — не родитель', () => {
    const other = '019a0000-0000-7000-8000-000000000002';
    const roots = buildCoreTree([session(), node('s1', { taskId: other })]);
    expect(roots).toHaveLength(2);
  });
});

describe('nodeLook / lookText — слово состояния', () => {
  it('законченная фоновая работа с кодом — «завершён (код N)»', () => {
    expect(lookText(bg('b1', { exitCode: 0 }))).toEqual({
      key: 'agentTree.status.completedCode',
      values: { code: 0 },
    });
  });

  it('идущая с bg-orphan — «осиротел», с bg-hang — «висит», снятая уборкой — reaped', () => {
    expect(nodeLook(bg('b1', { status: 'running', signals: ['bg-orphan'] }))).toBe('orphaned');
    expect(nodeLook(bg('b1', { status: 'running', signals: ['bg-hang'] }))).toBe('hanging');
    expect(nodeLook(bg('b1', { status: 'reaped', signals: ['bg-orphan'] }))).toBe('reaped');
  });

  it('потерянная фоновая работа: владелец кончился аварийно или сигнал bg-orphan — «осиротел — потерян»', () => {
    const lost = bg('b1', { status: 'lost' });
    expect(nodeLook(lost, { status: 'lost' })).toBe('orphanLost');
    expect(nodeLook(lost, { status: 'failed' })).toBe('orphanLost');
    expect(nodeLook(lost, { status: 'killed' })).toBe('orphanLost');
    expect(nodeLook(bg('b1', { status: 'lost', signals: ['bg-orphan'] }))).toBe('orphanLost');
    expect(lookText(lost, { status: 'lost' })).toEqual({ key: 'agentTree.status.orphanLost' });
  });

  it('владелец жив или кончился штатно, владельца нет, узел не фоновый — просто «потерян»', () => {
    const lost = bg('b1', { status: 'lost' });
    expect(nodeLook(lost, { status: 'running' })).toBe('lost');
    expect(nodeLook(lost, { status: 'completed' })).toBe('lost');
    expect(nodeLook(lost, { status: 'stopped' })).toBe('lost');
    expect(nodeLook(lost)).toBe('lost');
    expect(nodeLook(node('s1', { status: 'lost' }), { status: 'lost' })).toBe('lost');
  });
});

describe('agentsQuery — строка запроса списка', () => {
  it('чат — conversationId, фильтр «идёт» уходит ядру как есть, пустые не посылаются', () => {
    expect(agentsQuery('c1', { status: 'running' })).toEqual({
      conversationId: 'c1',
      status: 'running',
    });
    expect(agentsQuery('c1', {})).toEqual({ conversationId: 'c1' });
  });

  it('выбрана группа — охват группы вместо чата', () => {
    expect(agentsQuery('c1', { groupId: 'g1', model: 'sonnet' })).toEqual({
      groupId: 'g1',
      model: 'sonnet',
    });
  });
});

describe('ownerOf / workerNodes', () => {
  it('владелец — родитель той же задачи; у корня владельца нет', () => {
    const nodes = [session({ status: 'lost' }), bg('b1', { status: 'lost' })];
    expect(ownerOf(nodes, nodes[1]!)?.nodeId).toBe('sess');
    expect(ownerOf(nodes, nodes[0]!)).toBeUndefined();
  });

  it('фильтр группы: владелец узла чужого чата находится, хотя в узлах чата его нет', () => {
    const OTHER = '019a0000-0000-7000-8000-0000000000aa';
    const chat = [session({ status: 'completed' })];
    const owner = session({ taskId: OTHER, status: 'lost' });
    const orphan = bg('b9', { taskId: OTHER, status: 'lost' });
    const pool = ownerPool(chat, [owner, orphan]);
    expect(ownerOf(chat, orphan)).toBeUndefined();
    expect(ownerOf(pool, orphan)?.status).toBe('lost');
    expect(nodeLook(orphan, ownerOf(pool, orphan))).toBe('orphanLost');
    // Фильтра нет или показанное уже в чате — тот же массив, без копий.
    expect(ownerPool(chat, undefined)).toBe(chat);
    expect(ownerPool(chat, chat)).toBe(chat);
  });

  it('карточка группы: без сеансов единиц, идущие первыми', () => {
    const { rows, running, finished } = workerNodes([
      session({ status: 'running' }),
      node('s1', { startedAt: 3_000 }),
      bg('b1', { status: 'running', endedAt: null }),
    ]);
    expect(rows.map((r) => r.nodeId)).toEqual(['b1', 's1']);
    expect({ running, finished }).toEqual({ running: 1, finished: 1 });
  });
});
