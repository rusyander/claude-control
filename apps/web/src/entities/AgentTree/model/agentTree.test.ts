import { describe, it, expect } from 'vitest';
import type { ProgressAgent } from '@agentdeck/contracts';
import {
  agentCounts,
  agentState,
  agentTokenTotal,
  buildAgentTree,
  shortModel,
  visibleNodes,
} from './agentTree';

const agent = (id: string, extra: Partial<ProgressAgent> = {}): ProgressAgent => ({
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

  it('счёт карточки группы: идущие и все остальные исходы', () => {
    const agents = [
      agent('run', { status: 'running' }),
      agent('ok'),
      agent('bad', { status: 'failed' }),
      agent('stop', { status: 'failed', stopped: true }),
      agent('nested', { parentId: 'run' }),
    ];
    expect(agentCounts(agents, false, true)).toEqual({ total: 5, running: 1, finished: 4 });
    // Процесс умер — идущий оборван, он тоже закончил.
    expect(agentCounts(agents, false, false)).toEqual({ total: 5, running: 0, finished: 5 });
  });

  it('расход одним числом и короткое имя модели', () => {
    expect(
      agentTokenTotal(
        agent('t', { tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 1 } }),
      ),
    ).toBe(116);
    expect(agentTokenTotal(agent('t'))).toBe(0);
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet-4-5');
    expect(shortModel(undefined)).toBeUndefined();
  });
});
