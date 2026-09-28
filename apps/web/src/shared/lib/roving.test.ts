import { describe, expect, it } from 'vitest';
import { rovingTarget } from './roving';

const ITEMS = ['CLAUDE.md', 'AGENTS.md', 'both'] as const;

describe('rovingTarget — куда ведёт клавиша в группе с одной остановкой', () => {
  it('стрелки вперёд и назад, по кругу с края', () => {
    expect(rovingTarget(ITEMS, 'CLAUDE.md', 'ArrowRight')).toBe('AGENTS.md');
    expect(rovingTarget(ITEMS, 'CLAUDE.md', 'ArrowDown')).toBe('AGENTS.md');
    expect(rovingTarget(ITEMS, 'both', 'ArrowRight')).toBe('CLAUDE.md');
    expect(rovingTarget(ITEMS, 'AGENTS.md', 'ArrowLeft')).toBe('CLAUDE.md');
    expect(rovingTarget(ITEMS, 'CLAUDE.md', 'ArrowUp')).toBe('both');
  });

  it('Home и End — крайние', () => {
    expect(rovingTarget(ITEMS, 'AGENTS.md', 'Home')).toBe('CLAUDE.md');
    expect(rovingTarget(ITEMS, 'AGENTS.md', 'End')).toBe('both');
  });

  it('текущего нет в списке — стрелка ведёт с края, а не мимо', () => {
    expect(rovingTarget(ITEMS, undefined, 'ArrowRight')).toBe('CLAUDE.md');
    expect(rovingTarget(ITEMS, 'gone', 'ArrowLeft')).toBe('both');
  });

  it('прочие клавиши и пустой список — ничего', () => {
    expect(rovingTarget(ITEMS, 'CLAUDE.md', 'Enter')).toBeUndefined();
    expect(rovingTarget(ITEMS, 'CLAUDE.md', 'a')).toBeUndefined();
    expect(rovingTarget([], undefined, 'ArrowRight')).toBeUndefined();
  });
});
