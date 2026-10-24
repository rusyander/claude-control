import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import { correlateGroups, signalSignature } from './correlate.ts';

/**
 * R23: одна и та же команда застревает в нескольких группах плана. Вход — активные
 * сигналы групп, как они лежат в срезе сторожа (команда — под маской, у каждой группы
 * свой каталог копии).
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T10:00:00Z');

const signal = (
  rule: GroupSignal['rule'],
  groupIndex: number,
  minute: number,
  params: Record<string, string>,
  extra: Partial<GroupSignal> = {},
): GroupSignal => ({
  id: `${rule}-${groupIndex}-${minute}`,
  rule,
  severity: 'warn',
  groupIndex,
  chatId: `child-${groupIndex}`,
  at: new Date(T0 + minute * MIN).toISOString(),
  numbers: {},
  textKey: `groupWatch.rule.${rule}`,
  params,
  ...extra,
});

const settings = (patch: Partial<GroupWatch> = {}): GroupWatch => ({
  ...GROUP_WATCH_DEFAULTS,
  ...patch,
});

describe('correlateGroups R23 одна беда в нескольких группах', () => {
  it('R15 на одной проверке в двух группах за 40 мин — R23 на обеих, с командой без перехода в копию', () => {
    const groups = new Map([
      [1, [signal('R15', 1, 0, { call: 'cd /work/app/.copies/g1 && pnpm test:e2e …' })]],
      [2, [signal('R15', 2, 40, { call: 'cd /work/app/.copies/g2 && pnpm  test:e2e' })]],
      [3, [signal('R4', 3, 10, { command: 'pnpm lint' })]],
    ]);
    const hits = correlateGroups(groups, settings(), T0 + 41 * MIN);
    expect([...hits.keys()].sort()).toEqual([1, 2]);
    expect(hits.get(1)).toEqual({
      rule: 'R23',
      severity: 'alert',
      numbers: { groups: 2, spanMin: 40 },
      params: { command: 'pnpm test:e2e' },
      since: T0,
    });
    expect(hits.get(2)).toEqual(hits.get(1));
  });

  it('разные команды, окно шире `crossGroupMinutes`, закрытый сигнал, порог групп — тишина', () => {
    const different = new Map([
      [1, [signal('R15', 1, 0, { call: 'pnpm test' })]],
      [2, [signal('R15', 2, 5, { call: 'pnpm lint' })]],
    ]);
    expect(correlateGroups(different, settings(), T0).size).toBe(0);
    const apart = new Map([
      [1, [signal('R24', 1, 0, { call: 'pnpm test', error: 'x' })]],
      [2, [signal('R24', 2, 61, { call: 'pnpm test', error: 'x' })]],
    ]);
    expect(correlateGroups(apart, settings(), T0 + 62 * MIN).size).toBe(0);
    // Окно читается: 90 мин — те же два падения уже одна беда.
    expect(correlateGroups(apart, settings({ crossGroupMinutes: 90 }), T0).size).toBe(2);
    const cleared = new Map([
      [1, [signal('R16', 1, 0, { call: 'pnpm test' })]],
      [2, [signal('R16', 2, 5, { call: 'pnpm test' }, { clearedAt: new Date(T0).toISOString() })]],
    ]);
    expect(correlateGroups(cleared, settings(), T0).size).toBe(0);
    const pair = new Map([
      [1, [signal('R16', 1, 0, { call: 'pnpm test' })]],
      [2, [signal('R16', 2, 5, { call: 'pnpm test' })]],
    ]);
    expect(correlateGroups(pair, settings({ crossGroupCount: 3 }), T0).size).toBe(0);
  });

  it('правило вне списка (R1 молчание) не сравнивается, даже с той же подстановкой', () => {
    const groups = new Map([
      [1, [signal('R1', 1, 0, { call: 'pnpm test' })]],
      [2, [signal('R1', 2, 5, { call: 'pnpm test' })]],
    ]);
    expect(correlateGroups(groups, settings(), T0).size).toBe(0);
  });

  it('F-114: повтор проверки R4 в трёх группах — привычка групп, не общая беда: R23 нет', () => {
    const groups = new Map([
      [1, [signal('R4', 1, 0, { command: 'pnpm lint' })]],
      [2, [signal('R4', 2, 5, { command: 'pnpm lint' })]],
      [3, [signal('R4', 3, 9, { command: 'pnpm lint' })]],
    ]);
    expect(correlateGroups(groups, settings(), T0 + 10 * MIN).size).toBe(0);
  });

  it('F-89: строки сигнала совпали по обрезанному началу, отпечатки разные — R23 нет; одинаковые — R23 с отпечатком', () => {
    const shown = 'node tools/qa/check-run-layers.mjs --stand http://127.0.0.1:5178 …';
    const different = new Map([
      [1, [signal('R15', 1, 0, { call: shown, sig: 'aaaaaaaaaaaa' })]],
      [2, [signal('R15', 2, 5, { call: shown, sig: 'bbbbbbbbbbbb' })]],
    ]);
    expect(correlateGroups(different, settings(), T0 + 6 * MIN).size).toBe(0);
    const same = new Map([
      [1, [signal('R15', 1, 0, { call: shown, sig: 'aaaaaaaaaaaa' })]],
      [2, [signal('R24', 2, 5, { call: shown, sig: 'aaaaaaaaaaaa', error: 'x' })]],
    ]);
    const hits = correlateGroups(same, settings(), T0 + 6 * MIN);
    expect([...hits.keys()].sort()).toEqual([1, 2]);
    expect(hits.get(1)?.params).toEqual({
      command: 'node tools/qa/check-run-layers.mjs --stand http://127.0.0.1:5178',
      sig: 'aaaaaaaaaaaa',
    });
  });

  it('подпись: шаги перехода в каталог и хвост маски срезаны, пробелы схлопнуты; нет команды — нет подписи', () => {
    expect(
      signalSignature({ params: { command: 'pushd /a && npx vitest run  a.test.ts …' } }),
    ).toBe('npx vitest run a.test.ts');
    expect(signalSignature({ params: { call: 'mcp__playwright__browser_click' } })).toBe(
      'mcp__playwright__browser_click',
    );
    expect(signalSignature({ params: { call: '…' } })).toBeUndefined();
    expect(signalSignature({})).toBeUndefined();
  });
});
