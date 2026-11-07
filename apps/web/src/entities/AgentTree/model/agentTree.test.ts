import { describe, it, expect } from 'vitest';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { agentState, buildAgentTree, shortModel, visibleNodes, withCoreFacts } from './agentTree';
import type { TreeAgent } from './agentTree.types';

const agent = (id: string, extra: Partial<TreeAgent> = {}): TreeAgent => ({
  id,
  kind: 'Explore',
  description: id,
  status: 'done',
  ...extra,
});

describe('дерево агентов', () => {
  it('вложенный — под родителем по parentId, порядок сохранён, уровни по глубине', () => {
    const roots = buildAgentTree([
      agent('a'),
      agent('b', { status: 'running' }),
      agent('b1', { parentId: 'b' }),
      agent('b1x', { parentId: 'b1' }),
      agent('c'),
    ]);
    expect(roots.map((node) => node.agent.id)).toEqual(['a', 'b', 'c']);
    const b = roots[1];
    expect(b?.children.map((node) => [node.agent.id, node.level])).toEqual([['b1', 2]]);
    expect(b?.children[0]?.children.map((node) => [node.agent.id, node.level])).toEqual([
      ['b1x', 3],
    ]);
  });

  it('родителя нет в списке или сам себе родитель — узел в корне, а не пропал', () => {
    const roots = buildAgentTree([agent('x', { parentId: 'gone' }), agent('y', { parentId: 'y' })]);
    expect(roots.map((node) => [node.agent.id, node.level])).toEqual([
      ['x', 1],
      ['y', 1],
    ]);
  });

  it('свёрнутый узел прячет всю ветку из обхода стрелками', () => {
    const roots = buildAgentTree([
      agent('a'),
      agent('a1', { parentId: 'a' }),
      agent('a2', { parentId: 'a1' }),
      agent('b'),
    ]);
    const ids = (collapsed: string[]) =>
      visibleNodes(roots, new Set(collapsed)).map((node) => node.agent.id);
    expect(ids([])).toEqual(['a', 'a1', 'a2', 'b']);
    expect(ids(['a1'])).toEqual(['a', 'a1', 'b']);
    expect(ids(['a'])).toEqual(['a', 'b']);
  });
});

describe('состояние субагента', () => {
  it('остановленный — «stopped», даже если статус failed; умерший с процессом — «lost»', () => {
    expect(agentState(agent('s', { status: 'failed', stopped: true }), false, true)).toBe(
      'stopped',
    );
    expect(agentState(agent('r', { status: 'running' }), false, false)).toBe('lost');
    expect(agentState(agent('r', { status: 'running' }), false, true)).toBe('running');
    // Ход идёт — процесс по определению жив, «lost» не бывает.
    expect(agentState(agent('r', { status: 'running' }), true, false)).toBe('running');
    // Старый сервер без признака процесса — как было.
    expect(agentState(agent('r', { status: 'running' }), false)).toBe('running');
  });

  it('вызов Agent оборван паузой — «оборван», не «ошибка», даже при живом ходе', () => {
    expect(agentState(agent('p', { status: 'failed', interrupted: true }), true, true)).toBe(
      'lost',
    );
    expect(agentState(agent('f', { status: 'failed' }), true, true)).toBe('failed');
  });

  it('короткое имя модели', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet-4-5');
    expect(shortModel(undefined)).toBeUndefined();
  });
});

const SESSION = '019a0000-0000-7000-8000-000000000003';
const core = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
  nodeId,
  parentId: SESSION,
  taskId: '019a0000-0000-7000-8000-000000000001',
  kind: 'subagent',
  status: 'completed',
  stepId: null,
  unitId: null,
  sessionId: SESSION,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 61_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: null,
  returnExcerpt: null,
  ...over,
});

describe('withCoreFacts — факты ядра поверх строк транскрипта', () => {
  it('узел с тем же id даёт модель, вызовы, расход и конец; сессия ядра — не родитель', () => {
    const [row] = withCoreFacts(
      [agent('a')],
      [core('a', { model: 'claude-sonnet-4-5', spend: { tokens: 900, windowShare: null } })],
    );
    expect(row).toMatchObject({ model: 'claude-sonnet-4-5', toolCalls: 0, spendTokens: 900 });
    expect(row?.endedAt).toBe(new Date(61_000).toISOString());
    expect(row?.parentId).toBeUndefined();
  });

  it('расход null — поля нет (не ноль); идущему конец не ставится', () => {
    const [row] = withCoreFacts(
      [agent('a', { status: 'running' })],
      [core('a', { status: 'running', endedAt: null })],
    );
    expect(row && 'spendTokens' in row).toBe(false);
    expect(row?.endedAt).toBeUndefined();
  });

  it('вложенные уровни — под родителем, по порядку запуска; фон и сеансы — нет', () => {
    const rows = withCoreFacts(
      [agent('a')],
      [
        core('a'),
        core('a2', { parentId: 'a', startedAt: 9_000, status: 'killed' }),
        core('a1', { parentId: 'a', startedAt: 5_000, briefExcerpt: 'Проверка\nещё' }),
        core('a1x', { parentId: 'a1', startedAt: 6_000, status: 'lost' }),
        core('bg', { kind: 'background-shell', parentId: 'a', background: true }),
        core(SESSION, { kind: 'unit-session', parentId: null }),
      ],
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'a1', 'a1x', 'a2']);
    const roots = buildAgentTree(rows);
    expect(roots.map((root) => root.agent.id)).toEqual(['a']);
    expect(roots[0]?.children.map((child) => child.agent.id)).toEqual(['a1', 'a2']);
    expect(roots[0]?.children[0]?.children[0]?.agent.id).toBe('a1x');
    expect(rows[1]).toMatchObject({ description: 'Проверка', status: 'done', parentId: 'a' });
    expect(agentState(rows[2] as TreeAgent, false)).toBe('lost');
    expect(agentState(rows[3] as TreeAgent, false)).toBe('stopped');
  });

  // Чат чужого CLI (qwen, opencode): транскрипта Claude у него нет, строк из транскрипта — ни одной,
  // и дерево ядра — единственное дерево его субагентов. Прежде верхний субагент (родитель — сеанс
  // ядра) отбрасывался, и «План агента» у такого чата был пуст (F-07).
  it('строк транскрипта нет (чужой CLI) — верхние субагенты ядра встают корнями, вложенные под ними', () => {
    const rows = withCoreFacts(
      [],
      [
        core('q2', { startedAt: 8_000, status: 'running', endedAt: null }),
        core('q1', { startedAt: 3_000, briefExcerpt: 'Проверка qwen\nдальше' }),
        core('q1a', { parentId: 'q1', startedAt: 4_000 }),
        core('bg', { kind: 'background-shell', parentId: 'q1', background: true }),
        core(SESSION, { kind: 'unit-session', parentId: null }),
      ],
    );
    expect(rows.map((row) => row.id)).toEqual(['q1', 'q1a', 'q2']);
    expect(rows[0]).toMatchObject({ description: 'Проверка qwen', status: 'done' });
    expect(rows[0]?.parentId).toBeUndefined();
    expect(rows[2]).toMatchObject({ status: 'running' });
    const roots = buildAgentTree(rows);
    expect(roots.map((root) => root.agent.id)).toEqual(['q1', 'q2']);
    expect(roots[0]?.children.map((child) => child.agent.id)).toEqual(['q1a']);
    // Строке только из ядра — тип узла для подписи словарём; строке транскрипта — нет.
    expect(rows.map((row) => row.coreKind)).toEqual(['subagent', 'subagent', 'subagent']);
    const [named] = withCoreFacts([agent('a')], [core('a')]);
    expect(named?.coreKind).toBeUndefined();
  });

  it('верхний субагент ядра, чьей строки в транскрипте ещё нет, добавляется; строка Claude не двоится', () => {
    const rows = withCoreFacts(
      [agent('a')],
      [core('a', { model: 'claude-haiku-4-5' }), core('z', { startedAt: 2_000 })],
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'z']);
    expect(rows[0]).toMatchObject({ model: 'claude-haiku-4-5' });
  });

  it('узлов ядра нет — строки как есть', () => {
    const rows = [agent('a', { status: 'running' })];
    expect(withCoreFacts(rows, [])).toEqual(rows);
  });
});
