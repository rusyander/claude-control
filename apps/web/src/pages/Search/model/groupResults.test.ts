import { describe, it, expect } from 'vitest';
import type { SearchResult } from '@claude-control/contracts';
import { groupResults } from './groupResults';

const result = (over: Partial<SearchResult>): SearchResult => ({
  kind: 'rule',
  id: 'r1',
  title: 'Правило',
  snippet: 'фрагмент',
  pagePath: 'rules',
  ...over,
});

describe('groupResults', () => {
  it('пустой список даёт пустой результат', () => {
    expect(groupResults([])).toEqual([]);
  });

  it('группирует результаты одного вида в одну секцию', () => {
    const groups = groupResults([
      result({ id: 'r1', kind: 'rule' }),
      result({ id: 'r2', kind: 'rule' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('rule');
    expect(groups[0]?.results.map((item) => item.id)).toEqual(['r1', 'r2']);
  });

  it('раскладывает разные виды по секциям в порядке навигации', () => {
    // На вход подаём в обратном порядке — на выходе порядок фиксированный.
    const groups = groupResults([
      result({ kind: 'env', id: 'e1', pagePath: 'env' }),
      result({ kind: 'rule', id: 'r1', pagePath: 'rules' }),
      result({ kind: 'mcp', id: 'm1', pagePath: 'mcp' }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['rule', 'mcp', 'env']);
  });

  it('не создаёт секции для видов без результатов', () => {
    const groups = groupResults([result({ kind: 'skill', id: 's1', pagePath: 'skills' })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('skill');
  });
});
