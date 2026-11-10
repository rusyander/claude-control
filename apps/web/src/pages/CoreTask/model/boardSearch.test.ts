import { describe, expect, it } from 'vitest';
import { coreBoardSearch, coreViewOf, groupsBoardTarget } from './boardSearch';

describe('core section address', () => {
  it('without a view key the section is the board; «list» is the toggle', () => {
    expect(coreViewOf({})).toBe('board');
    expect(coreViewOf({ view: 'list' })).toBe('list');
    expect(coreViewOf({ view: 'kanban' })).toBe('board');
  });

  it('board keys survive parsing, unknown values are dropped rather than guessed', () => {
    expect(coreBoardSearch({ view: 'list', lane: 'group', group: 'g-1', other: 'x' })).toEqual({
      view: 'list',
      lane: 'group',
      group: 'g-1',
    });
    expect(coreBoardSearch({ view: 'grid', lane: 'tickets', group: '' })).toEqual({});
    expect(coreBoardSearch({ view: 3 })).toEqual({});
  });

  it('the former /groups address lands on the board in group-lane mode', () => {
    expect(groupsBoardTarget()).toEqual({
      to: '/core',
      search: { view: 'board', lane: 'group' },
    });
  });
});
