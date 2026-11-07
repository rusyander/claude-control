import { describe, expect, it } from 'vitest';
import {
  CLASS_THRESHOLDS_DEFAULT,
  type ClassSignals,
  type ReconMap,
  type TaskClass,
} from '@agentdeck/contracts/core/lead';
import type { CheckEntry, CheckRegistry } from '@agentdeck/contracts/core/records';
import { decideClass } from './classify.ts';
import { classSignalsOf, touchedUnitsOf } from './signals.ts';

/**
 * Классификатор ведущего (W2-8): таблица по каждой границе порогов по умолчанию (S ≤3 файлов ∧ 1
 * единица; M ≤10 ∧ ≤2; XL — пунктов ≥2 или единиц ≥5 со связями), подъём «нет проверки» на одну
 * ступень (не выше L), модель только поднимает, человек — в обе стороны. Признаки — из карты
 * разведки и реестра профиля.
 */

const T = CLASS_THRESHOLDS_DEFAULT;

const sig = (over: Partial<ClassSignals>): ClassSignals => ({
  files: 1,
  units: 1,
  crossUnitDeps: 0,
  checkCovered: true,
  risk: [],
  items: 1,
  ...over,
});

interface Row {
  name: string;
  signals: Partial<ClassSignals>;
  proposal?: TaskClass;
  human?: TaskClass;
  want: TaskClass;
  fromSignals: TaskClass;
}

const ROWS: Row[] = [
  {
    name: '3 files, 1 unit, covered → S (upper S edge)',
    signals: { files: 3 },
    want: 'S',
    fromSignals: 'S',
  },
  { name: '4 files → M (one past S)', signals: { files: 4 }, want: 'M', fromSignals: 'M' },
  { name: '0 files → S', signals: { files: 0 }, want: 'S', fromSignals: 'S' },
  {
    name: '2 units, 3 files → M (S needs one unit)',
    signals: { files: 3, units: 2 },
    want: 'M',
    fromSignals: 'M',
  },
  {
    name: '10 files, 2 units → M (upper M edge)',
    signals: { files: 10, units: 2 },
    want: 'M',
    fromSignals: 'M',
  },
  { name: '11 files → L (one past M)', signals: { files: 11 }, want: 'L', fromSignals: 'L' },
  {
    name: '3 units → L (one past M units)',
    signals: { files: 5, units: 3 },
    want: 'L',
    fromSignals: 'L',
  },
  {
    name: 'risk on 1 file → M, not S',
    signals: { files: 1, risk: ['path:migration'] },
    want: 'M',
    fromSignals: 'M',
  },
  { name: '2 items → XL', signals: { items: 2 }, want: 'XL', fromSignals: 'XL' },
  {
    name: '5 units with a cross dep → XL',
    signals: { files: 20, units: 5, crossUnitDeps: 1 },
    want: 'XL',
    fromSignals: 'XL',
  },
  {
    name: '5 units without cross deps → L',
    signals: { files: 20, units: 5 },
    want: 'L',
    fromSignals: 'L',
  },
  {
    name: '4 units with a cross dep → L (one under XL units)',
    signals: { files: 20, units: 4, crossUnitDeps: 2 },
    want: 'L',
    fromSignals: 'L',
  },
  { name: 'no check: S → M', signals: { checkCovered: false }, want: 'M', fromSignals: 'S' },
  {
    name: 'registry unread: M → L',
    signals: { files: 8, checkCovered: null },
    want: 'L',
    fromSignals: 'M',
  },
  {
    name: 'no check at L stays L (capped)',
    signals: { files: 30, checkCovered: false },
    want: 'L',
    fromSignals: 'L',
  },
  { name: 'model raises S → L', signals: {}, proposal: 'L', want: 'L', fromSignals: 'S' },
  {
    name: 'model proposes S for L signals → stays L',
    signals: { files: 30 },
    proposal: 'S',
    want: 'L',
    fromSignals: 'L',
  },
  { name: 'human lowers L → S', signals: { files: 30 }, human: 'S', want: 'S', fromSignals: 'L' },
];

describe('lead classifier: the boundary table', () => {
  for (const row of ROWS)
    it(row.name, () => {
      const d = decideClass({
        signals: sig(row.signals),
        thresholds: T,
        proposal: row.proposal ?? null,
        human: row.human ?? null,
      });
      expect({ class: d.class, fromSignals: d.fromSignals }).toEqual({
        class: row.want,
        fromSignals: row.fromSignals,
      });
      expect(d.reasons.length).toBeGreaterThan(0);
    });

  it('a missing check is named as raisedBy no-check', () => {
    const d = decideClass({
      signals: sig({ checkCovered: false }),
      thresholds: T,
      proposal: null,
      human: null,
    });
    expect(d.raised).toEqual([{ cause: 'no-check', from: 'S', to: 'M' }]);
  });

  it('L without a check stays L and the reason names the no-check cap', () => {
    const d = decideClass({
      signals: sig({ files: 30, checkCovered: false }),
      thresholds: T,
      proposal: null,
      human: null,
    });
    expect({ class: d.class, raised: d.raised }).toEqual({ class: 'L', raised: [] });
    expect(d.reasons).toContainEqual(expect.stringMatching(/raisedBy no-check capped at L/));
  });

  it('a lower model proposal is recorded as refusedLower with the reason', () => {
    const d = decideClass({
      signals: sig({ files: 30 }),
      thresholds: T,
      proposal: 'S',
      human: null,
    });
    expect(d.refusedLower).toEqual({ proposed: 'S' });
    expect(d.reasons.join(' ')).toContain('only a human lowers');
  });
});

// Признакам нужны только класс и папка проверки; прочие поля записи реестра им безразличны.
const runner = (cwd: string): CheckEntry =>
  ({
    id: `vitest:${cwd}`,
    class: 'test-runner',
    argv: ['vitest'],
    cwd,
    unit: 'package',
    requiredAt: [],
    baseDependent: false,
  }) as unknown as CheckEntry;

const registry: CheckRegistry = {
  units: {
    web: { paths: ['apps/web'], consumes: ['contracts'] },
    contracts: { paths: ['packages/contracts'], consumes: [] },
    server: { paths: ['apps/server'], consumes: ['contracts'] },
  },
  machinery: [],
  checks: [runner('apps/web'), runner('packages/contracts')],
  rejected: [],
};

const mapOf = (paths: string[]): ReconMap => ({
  lines: ['area'],
  files: paths.map((path) => ({ path, why: 'touched' })),
  tests: [],
  owners: [],
});

describe('lead classifier: signals from the recon map and the profile registry', () => {
  it('files, units, cross deps and coverage come from the map over the registry', () => {
    const s = classSignalsOf({
      map: mapOf(['apps/web/a.ts', 'packages/contracts/b.ts', 'apps/web/a.ts']),
      registry,
      items: 1,
    });
    expect(s).toEqual({
      files: 2,
      units: 2,
      crossUnitDeps: 1,
      checkCovered: true,
      risk: [],
      items: 1,
    });
  });

  it('files outside every registry unit count as one more (unknown) unit, so they cannot keep a task S', () => {
    const s = classSignalsOf({
      map: mapOf(['apps/web/a.ts', 'tools/x.ts', 'scripts/y.ts']),
      registry,
      items: 1,
    });
    expect(s.units).toBe(2);
    expect(
      decideClass({ signals: s, thresholds: T, proposal: null, human: null }).fromSignals,
    ).toBe('M');
  });

  it('a file no test runner covers makes the check unproven', () => {
    const s = classSignalsOf({ map: mapOf(['apps/server/x.ts']), registry, items: 1 });
    expect(s.checkCovered).toBe(false);
  });

  it('an unread registry gives units by top folder and coverage unknown', () => {
    const s = classSignalsOf({ map: mapOf(['a/x.ts', 'b/y.ts']), registry: null, items: 0 });
    expect(s).toMatchObject({ units: 2, checkCovered: null, items: 1 });
  });

  it('a migration path is a named risk', () => {
    const s = classSignalsOf({ map: mapOf(['db/migrations/001.sql']), registry, items: 1 });
    expect(s.risk).toContain('path:migration');
  });

  it('a contract check over its own folder is a risk; one from the repo root is not', () => {
    const contract = (cwd: string): CheckEntry =>
      ({ ...runner(cwd), id: `contract:${cwd || 'root'}`, class: 'contract' }) as CheckEntry;
    const scoped = { ...registry, checks: [...registry.checks, contract('packages/contracts')] };
    expect(
      classSignalsOf({ map: mapOf(['packages/contracts/b.ts']), registry: scoped, items: 1 }).risk,
    ).toEqual(['check:contract:contract:packages/contracts']);
    const rooted = { ...registry, checks: [...registry.checks, contract('')] };
    const s = classSignalsOf({ map: mapOf(['apps/web/a.ts']), registry: rooted, items: 1 });
    expect(s.risk).toEqual([]);
    expect(decideClass({ signals: s, thresholds: T, proposal: null, human: null }).class).toBe('S');
  });

  it('touched units name the registry units of the map files', () => {
    expect(touchedUnitsOf(mapOf(['apps/server/x.ts', 'apps/web/y.ts']), registry)).toEqual([
      'server',
      'web',
    ]);
  });
});
