import { describe, expect, it } from 'vitest';
import type { TreeRow } from '@agentdeck/contracts/core/records';
import { fixtureEntry, fixtureRegistry, fixtureRows, otherBlob } from '../__fixtures__/registry.ts';
import { absentKeyOf, closureOf, diffParts, keyOf, type KeyContext } from './index.ts';

/**
 * Ключ проверки (04:10, D§3.3). Мутанты D§4: M1 ключ без id проверки, M3 замыкание без общей
 * библиотеки, M4 замыкание без обвязки — каждый случай ниже краснеет на своём мутанте. Режим
 * файла в отпечатке (R:S2-32d): `chmod +x` — новый ключ.
 */

const digest = (v: string): string => `d(${v})`.padEnd(64, '0');

function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return {
    registry: fixtureRegistry(),
    rows: { value: fixtureRows() },
    baseRows: null,
    selection: [],
    inputs: { value: { '.env': 'absent' } },
    tools: { node: 'v22.6.0' },
    env: { NODE_ENV: 'test', APP_MODE: 'a', HOME: '/home/x' },
    envDigest: digest,
    ...over,
  };
}

function keyAt(over: Partial<KeyContext> = {}, unit = 'app', entry = fixtureEntry()): string {
  const fact = keyOf(entry, unit, ctx(over));
  if (!('value' in fact)) throw new Error(JSON.stringify(fact));
  return fact.value.key;
}

const rows = (edit: Record<string, Partial<TreeRow>>) => ({ value: fixtureRows(edit) });

describe('verifier/key', () => {
  it('P07 M1 the check id is in the key: two checks over one unit and tree never share a key', () => {
    expect(keyAt({}, 'app', fixtureEntry({ id: 'tests' }))).not.toBe(
      keyAt({}, 'app', fixtureEntry({ id: 'tests-2' })),
    );
  });

  it('P07 M3 a consumed library is in the consumer closure; an unrelated unit is not', () => {
    expect(closureOf(fixtureRegistry(), 'app')).toEqual(['apps/app/', 'packages/shared/']);
    const before = keyAt();
    expect(keyAt({ rows: rows({ 'packages/shared/index.ts': { blob: otherBlob } }) })).not.toBe(
      before,
    );
    expect(keyAt({ rows: rows({ 'apps/admin/main.ts': { blob: otherBlob } }) })).toBe(before);
    expect(keyAt({ rows: rows({ 'README.md': { blob: otherBlob } }) })).toBe(before);
  });

  it('P07 M4 machinery is in every unit key', () => {
    const before = keyAt({}, 'admin');
    expect(keyAt({ rows: rows({ 'tools/gate.mjs': { blob: otherBlob } }) }, 'admin')).not.toBe(
      before,
    );
  });

  it('P07 file mode is in the fingerprint: chmod +x of the same blob is a new key', () => {
    const before = keyAt();
    expect(keyAt({ rows: rows({ 'apps/app/main.ts': { mode: '100755' } }) })).not.toBe(before);
  });

  it('P07 same content in another order (another copy, commit vs work tree) is the same key', () => {
    expect(keyAt({ rows: { value: [...fixtureRows()].reverse() } })).toBe(keyAt());
  });

  it('P07 selection, env allow-list, tools and inputs move the key; other env and values do not leak', () => {
    const before = keyAt();
    expect(keyAt({ selection: ['apps/app/main.test.ts'] })).not.toBe(before);
    expect(keyAt({ env: { NODE_ENV: 'prod', APP_MODE: 'a' } })).not.toBe(before);
    expect(keyAt({ env: { NODE_ENV: 'test', app_mode: 'a', HOME: '/y' } })).toBe(before);
    expect(keyAt({ env: { NODE_ENV: 'test', APP_MODE: 'a', APP_NEW: '1' } })).not.toBe(before);
    expect(keyAt({ tools: { node: 'v24.0.0' } })).not.toBe(before);
    expect(keyAt({ inputs: { value: { '.env': 'f'.repeat(64) } } })).not.toBe(before);
    const fact = keyOf(fixtureEntry(), 'app', ctx());
    expect(JSON.stringify(fact)).not.toContain('"test"');
  });

  it('P07 a base-dependent check keys the base side; others ignore the base', () => {
    const entry = fixtureEntry({ id: 'quality', baseDependent: true });
    const base1 = { value: fixtureRows() };
    const base2 = rows({ 'apps/app/main.ts': { blob: otherBlob } });
    expect(keyAt({ baseRows: base1 }, 'app', entry)).not.toBe(
      keyAt({ baseRows: base2 }, 'app', entry),
    );
    expect(keyAt({ baseRows: base1 })).toBe(keyAt({ baseRows: base2 }));
    expect('unknown' in keyOf(entry, 'app', ctx())).toBe(true);
  });

  it('P44 an unread input (tree, base, inputs) or an unknown unit is unknown, never a key', () => {
    const base = { unknown: 'EPERM' };
    const cases: [string, ReturnType<typeof keyOf>][] = [
      ['tree unknown', keyOf(fixtureEntry(), 'app', ctx({ rows: { unknown: 'timeout' } }))],
      ['tree absent', keyOf(fixtureEntry(), 'app', ctx({ rows: { absent: true } }))],
      ['inputs unknown', keyOf(fixtureEntry(), 'app', ctx({ inputs: { unknown: 'EPERM' } }))],
      [
        'base unknown',
        keyOf(fixtureEntry({ baseDependent: true }), 'app', ctx({ baseRows: base })),
      ],
      ['unit missing', keyOf(fixtureEntry(), 'ghost', ctx())],
      // путь реестра в другом регистре, чем в git: замыкание пустое — правка единицы ключ не двигала
      [
        'unit path covers no row',
        keyOf(
          fixtureEntry(),
          'app',
          ctx({
            registry: {
              ...fixtureRegistry(),
              units: {
                ...fixtureRegistry().units,
                app: { ...fixtureRegistry().units.app!, paths: ['Apps/App/'] },
              },
            },
          }),
        ),
      ],
    ];
    for (const [name, fact] of cases)
      expect({ name, unknown: 'unknown' in fact }).toEqual({
        name,
        unknown: true,
      });
  });

  it('G3 the absent key moves when the registry gains the entry; diffParts names what moved', () => {
    const reg = fixtureRegistry();
    const grown = fixtureRegistry({ checks: [...reg.checks, fixtureEntry({ id: 'e2e' })] });
    expect(absentKeyOf('e2e', reg).key).not.toBe(absentKeyOf('e2e', grown).key);
    expect(absentKeyOf('e2e', reg).key).toBe(absentKeyOf('e2e', fixtureRegistry()).key);
    const a = keyOf(fixtureEntry(), 'app', ctx());
    const b = keyOf(
      fixtureEntry(),
      'app',
      ctx({ env: { NODE_ENV: 'prod', APP_MODE: 'a' }, tools: { node: 'v24' } }),
    );
    if (!('value' in a) || !('value' in b)) throw new Error('no key');
    expect(diffParts(a.value.parts, b.value.parts)).toEqual(['env.NODE_ENV', 'tools.node']);
    expect(diffParts(null, b.value.parts)).toEqual(['all']);
    expect(closureOf(fixtureRegistry(), '.')).toEqual(['']);
  });
});
