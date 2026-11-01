import { describe, expect, it } from 'vitest';
import { decideOwnership, ownershipBrief } from './ownership.ts';

/** Владение единицы (06:64, 02:74): вне своих путей — `outside` с файлами и строка брифа. */
describe('ownership', () => {
  it('a unit editing outside its owned paths is named file by file; rooted paths never match deeper dirs', () => {
    const rows: { owned: string[]; changed: string[]; outside: string[]; fold?: boolean }[] = [
      { owned: ['src/api'], changed: ['src/api/a.ts', 'src/api/x/b.ts'], outside: [] },
      { owned: ['src/api'], changed: ['src/api/a.ts', 'src/web/b.ts'], outside: ['src/web/b.ts'] },
      { owned: ['src'], changed: ['pkg/src/a.ts'], outside: ['pkg/src/a.ts'] },
      { owned: ['**/*.md'], changed: ['docs/a.md', 'a.ts'], outside: ['a.ts'] },
      { owned: ['Src'], changed: ['src\\a.ts'], outside: [], fold: true },
      { owned: ['Src'], changed: ['src/a.ts'], outside: ['src/a.ts'] },
      { owned: ['**'], changed: ['any/where.ts'], outside: [] },
    ];
    for (const r of rows) {
      const d = decideOwnership(r.owned, r.changed, r.fold ?? false);
      expect({ ...r, got: d.outside, verdict: d.verdict }).toEqual({
        ...r,
        got: r.outside,
        verdict: r.outside.length > 0 ? 'outside' : 'inside',
      });
    }
  });

  it('brief names owned paths and the files edited outside them, capped', () => {
    expect(ownershipBrief(['src'], [])).toBe('Owned paths of this unit: src.');
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const text = ownershipBrief(['src'], many);
    expect(text).toContain('Edited outside owned paths: f0.ts');
    expect(text).toContain('(+5 more)');
    expect(text).not.toContain('f24.ts');
  });
});
