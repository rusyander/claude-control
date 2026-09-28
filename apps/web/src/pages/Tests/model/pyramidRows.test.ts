import { describe, expect, it } from 'vitest';
import type { ProjectTestPyramid } from '@agentdeck/contracts';
import { pyramidRows } from './pyramidRows';

const base: ProjectTestPyramid = {
  frameworks: [],
  split: false,
  truncated: false,
  checkedAt: '2026-09-27T10:00:00.000Z',
};
const count = (tests: number) => ({ files: 1, tests, dynamic: 0 });

/** Строки пирамиды: деление — только по меткам проекта, «не известно» — строкой, а не пропуском. */
describe('pages/Tests/model/pyramidRows', () => {
  it('без каркаса и без папки — две строки без счёта, а не пустая карточка', () => {
    expect(pyramidRows(base)).toEqual([{ layer: 'e2e' }, { layer: 'code', count: undefined }]);
  });

  it('без меток — одна строка кода; e2e с папкой', () => {
    const rows = pyramidRows({
      ...base,
      frameworks: [{ name: 'vitest', source: 'package.json' }],
      code: count(40),
      e2e: { ...count(5), dir: 'e2e' },
    });
    expect(rows.map((row) => [row.layer, row.count?.tests, row.dir])).toEqual([
      ['e2e', 5, 'e2e'],
      ['code', 40, undefined],
    ]);
  });

  it('метки проекта — e2e, интеграционные, модульные сверху вниз', () => {
    const rows = pyramidRows({
      ...base,
      frameworks: [{ name: 'pytest', source: 'pytest.ini' }],
      split: true,
      unit: count(30),
      integration: count(8),
    });
    expect(rows.map((row) => [row.layer, row.count?.tests])).toEqual([
      ['e2e', undefined],
      ['integration', 8],
      ['unit', 30],
    ]);
  });
});
