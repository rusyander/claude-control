import { describe, expect, it } from 'vitest';
import type { ProjectTestPyramid } from '@agentdeck/contracts';
import { pyramidRows } from './pyramid';

const base: ProjectTestPyramid = {
  frameworks: [],
  split: false,
  truncated: false,
  checkedAt: '2026-09-27T10:00:00.000Z',
};
const count = (tests: number) => ({ files: 1, tests, dynamic: 0 });

describe('entities/tests/pyramid', () => {
  it('без меток проекта — одна строка кода; без каркаса она без счёта', () => {
    expect(pyramidRows(base).map((row) => [row.layer, row.count])).toEqual([
      ['e2e', undefined],
      ['code', undefined],
    ]);
  });

  it('метки проекта — интеграционные и модульные отдельно, e2e сверху', () => {
    const rows = pyramidRows({
      ...base,
      split: true,
      unit: count(30),
      integration: count(8),
      e2e: { ...count(4), dir: 'e2e' },
    });
    expect(rows.map((row) => [row.layer, row.count?.tests])).toEqual([
      ['e2e', 4],
      ['integration', 8],
      ['unit', 30],
    ]);
  });
});
