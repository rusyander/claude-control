import { describe, expect, it } from 'vitest';
import { groupCopyName } from '@agentdeck/contracts';

/**
 * Имя копии группы (ревью 28.09, F-331): имя из одного суффикса давало
 * ведущий пробел, а копия, сделанная на другом языке интерфейса, наращивала
 * вторые скобки.
 */
describe('groupCopyName', () => {
  it('как прежде: «X (копия)», затем номер', () => {
    expect(groupCopyName('X', [], 'ru')).toBe('X (копия)');
    expect(groupCopyName('X', ['x (копия)'], 'ru')).toBe('X (копия 2)');
    expect(groupCopyName('X (копия)', ['X (копия)'], 'ru')).toBe('X (копия 2)');
  });

  it('суффикс другого языка снимается, а не наращивается', () => {
    expect(groupCopyName('X (копия)', [], 'en')).toBe('X (copy)');
    expect(groupCopyName('X (copy 3)', [], 'ru')).toBe('X (копия)');
  });

  it('имя из одного суффикса — без ведущего пробела', () => {
    const name = groupCopyName('(копия)', ['(копия)'], 'ru');
    expect(name).not.toMatch(/^\s/);
    expect(name).toBe('(копия) (копия)');
  });
});
