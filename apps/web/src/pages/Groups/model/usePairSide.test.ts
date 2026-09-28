import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupListItem } from '@entities/Group';

/**
 * F-113 (веб): выбор стороны у каждой пары свой. Без имени пары сервер отвечает
 * выбором «единственной пары проекта» — в проекте с двумя парами это `null`, и
 * карточка ВТОРОЙ пары показывала не ту сторону, пока первая была переключена.
 */
const calls: [string | undefined, string | undefined][] = [];
let answer: { groupKey: string | null } | undefined;

vi.mock('@entities/Group', () => ({
  useProjectGroupChoice: (path: string | undefined, group?: string) => {
    calls.push([path, group]);
    return { data: answer, isError: false };
  },
}));

const { usePairSide } = await import('./usePairSide');

function group(id: string, patch: Partial<GroupListItem> = {}): GroupListItem {
  return {
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order: 0,
    ...patch,
  };
}

const project = group('shop-review', {
  scope: { kind: 'project', path: 'c:/work/shop', provider: 'claude' },
});
const global = group('review-copy', { scope: { kind: 'global', provider: 'claude' } });

describe('usePairSide', () => {
  beforeEach(() => {
    calls.length = 0;
    answer = undefined;
  });

  it('спрашивает выбор ЭТОЙ пары — по id её проектной стороны', () => {
    usePairSide(global, project);
    expect(calls).toEqual([['c:/work/shop', 'shop-review']]);
  });

  it('выбор пары — глобальная сторона: показывается она; не выбрана — проектная', () => {
    answer = { groupKey: 'global:review-copy' };
    expect(usePairSide(global, project).shown.id).toBe('review-copy');
    answer = { groupKey: null };
    expect(usePairSide(global, project).shown.id).toBe('shop-review');
  });

  it('без пары выбор не спрашивается', () => {
    const alone = usePairSide(global, undefined);
    expect(calls).toEqual([[undefined, undefined]]);
    expect(alone.shown.id).toBe('review-copy');
  });
});
