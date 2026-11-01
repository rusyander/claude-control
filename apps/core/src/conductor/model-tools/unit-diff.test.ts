import { describe, expect, it } from 'vitest';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { unitDiff, type UnitDiffDeps } from './unit-diff.ts';

/** `unit_diff(file)` (03 §Context): только файл диффа единицы, под маской, длинное — с меткой. */

function deps(changed: Fact<string[]>, bodies: Record<string, Fact<string>>): UnitDiffDeps {
  return {
    changed: async () => changed,
    diffOf: async (f) => bodies[f] ?? { absent: true },
  };
}

describe('unit_diff model tool', () => {
  it('returns the body of a changed file, masked', async () => {
    const key = `sk-${'d'.repeat(40)}`;
    const got = await unitDiff(
      { file: './src/a.ts' },
      deps({ value: ['src/a.ts'] }, { 'src/a.ts': { value: `+const k = '${key}';` } }),
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.diff).not.toContain(key);
    expect(got.masked).toBe(1);
  });

  it('refuses a file outside the unit diff (the tool is no reader of the whole copy)', async () => {
    const got = await unitDiff({ file: 'secret/config.json' }, deps({ value: ['src/a.ts'] }, {}));
    expect(got).toMatchObject({ ok: false, code: 'not-in-unit' });
  });

  it('an unreadable unit diff is unknown, never an empty answer', async () => {
    const got = await unitDiff({ file: 'src/a.ts' }, deps({ unknown: 'timeout' }, {}));
    expect(got).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('a long body is cut with a marker naming where to read on', async () => {
    const got = await unitDiff(
      { file: 'big.txt' },
      deps({ value: ['big.txt'] }, { 'big.txt': { value: 'y'.repeat(500) } }),
      100,
    );
    expect(got.ok && got.cut).toBe(400);
    expect(got.ok && got.diff).toMatch(/\[… 400 bytes of the diff cut: read big\.txt in the copy/);
  });

  it('a new untracked file has no git body: named, not empty', async () => {
    const got = await unitDiff({ file: 'new.txt' }, deps({ value: ['new.txt'] }, {}));
    expect(got.ok && got.diff).toMatch(/no git body/);
  });

  it('bad arguments are refused with the call shape', async () => {
    expect(await unitDiff({ path: 'x' }, deps({ value: [] }, {}))).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
