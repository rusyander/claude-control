import { describe, it, expect } from 'vitest';
import {
  buildAgentTree,
  visibleNodes,
  type AgentTreeNode,
  type TreeAgent,
} from '@entities/AgentTree';
import { nodeKey, treeKeyTarget } from './treeKeys';

const agent = (id: string, parentId?: string): TreeAgent => ({
  id,
  kind: 'Explore',
  description: id,
  status: 'done',
  ...(parentId ? { parentId } : {}),
});

/** a, b (→ b1 → b1x), c — как «Ревью» с вложенной «Проверкой тестов». */
const roots = buildAgentTree([
  agent('a'),
  agent('b'),
  agent('b1', 'b'),
  agent('b1x', 'b1'),
  agent('c'),
]);

function find(id: string): AgentTreeNode {
  const all = visibleNodes(roots, new Set());
  const node = all.find((item) => item.agent.id === id);
  if (!node) throw new Error(id);
  return node;
}

function press(key: string, id: string, collapsed: string[] = []) {
  const shut = new Set(collapsed);
  const action = treeKeyTarget(key, find(id), visibleNodes(roots, shut), shut);
  if (action?.kind === 'focus') return `focus ${action.node.agent.id}`;
  if (action?.kind === 'toggle') return `toggle ${action.open ? 'open' : 'shut'}`;
  return action?.kind;
}

describe('клавиатура дерева агентов', () => {
  it('↑↓ — соседние видимые, без перехода по кругу', () => {
    expect(press('ArrowDown', 'a')).toBe('focus b');
    expect(press('ArrowDown', 'b')).toBe('focus b1');
    expect(press('ArrowDown', 'b', ['b'])).toBe('focus c');
    expect(press('ArrowDown', 'c')).toBeUndefined();
    expect(press('ArrowUp', 'a')).toBeUndefined();
    expect(press('ArrowUp', 'c')).toBe('focus b1x');
  });

  it('→ раскрывает свёрнутый, у раскрытого ведёт к первому вложенному, у листа — ничего', () => {
    expect(press('ArrowRight', 'b', ['b'])).toBe('toggle open');
    expect(press('ArrowRight', 'b')).toBe('focus b1');
    expect(press('ArrowRight', 'a')).toBeUndefined();
  });

  it('← сворачивает раскрытый, иначе ведёт к родителю; у корневого листа — ничего', () => {
    expect(press('ArrowLeft', 'b')).toBe('toggle shut');
    expect(press('ArrowLeft', 'b1x')).toBe('focus b1');
    expect(press('ArrowLeft', 'b1', ['b1'])).toBe('focus b');
    expect(press('ArrowLeft', 'a')).toBeUndefined();
  });

  it('Home/End — края видимого; Enter и пробел открывают ход; прочие клавиши не наши', () => {
    expect(press('Home', 'c')).toBe('focus a');
    expect(press('End', 'a')).toBe('focus c');
    expect(press('Enter', 'b1')).toBe('open');
    expect(press(' ', 'b1')).toBe('open');
    expect(press('Tab', 'b1')).toBeUndefined();
  });

  it('адрес узла — id вызова Agent (он же узел ядра)', () => {
    expect(nodeKey(find('a'))).toBe('a');
    expect(nodeKey({ agent: agent('z'), level: 1, children: [] })).toBe('z');
  });
});
