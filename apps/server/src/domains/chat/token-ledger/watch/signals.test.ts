import { describe, expect, it } from 'vitest';
import { GROUP_SIGNALS_CAP, type GroupSignal } from '@agentdeck/contracts/group-watch';
import { capSignals, clearChatSignals, mergeSignals, signalsToNotify } from './signals.ts';
import type { RuleHit } from './watch.types.ts';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const scope = { chatId: 'c1', groupIndex: 2, stage: 'work' };
let seq = 0;
const makeId = () => `s${++seq}`;
const hit = (
  rule: RuleHit['rule'],
  numbers: Record<string, number>,
  severity: RuleHit['severity'] = 'warn',
): RuleHit => ({
  rule,
  severity,
  numbers,
  since: T0,
});

describe('group watch signals', () => {
  it('raises a new signal once, updates its numbers, closes it when the condition ends', () => {
    const first = mergeSignals([], scope, [hit('R4', { runs: 3 })], T0, makeId);
    expect(first.structural).toBe(true);
    expect(first.raised).toHaveLength(1);
    expect(first.signals[0]).toMatchObject({
      rule: 'R4',
      chatId: 'c1',
      groupIndex: 2,
      stage: 'work',
      textKey: 'groupWatch.rule.R4',
      numbers: { runs: 3 },
    });

    const again = mergeSignals(first.signals, scope, [hit('R4', { runs: 4 })], T0 + 1000, makeId);
    expect(again.raised).toHaveLength(0);
    expect(again.structural).toBe(false);
    expect(again.numbers).toBe(true);
    expect(again.signals).toHaveLength(1);
    expect(again.signals[0]?.numbers).toEqual({ runs: 4 });

    const quiet = mergeSignals(again.signals, scope, [], T0 + 2000, makeId);
    expect(quiet.structural).toBe(true);
    expect(quiet.signals[0]?.clearedAt).toBe(new Date(T0 + 2000).toISOString());

    // Снова сработало — новый активный сигнал, закрытый остаётся строкой.
    const back = mergeSignals(quiet.signals, scope, [hit('R4', { runs: 3 })], T0 + 3000, makeId);
    expect(back.raised).toHaveLength(1);
    expect(back.signals).toHaveLength(2);
  });

  it('a changed substitution alone marks the record dirty', () => {
    const first = mergeSignals(
      [],
      scope,
      [{ ...hit('R4', { runs: 3 }), params: { command: 'pnpm test' } }],
      T0,
      makeId,
    );
    const moved = mergeSignals(
      first.signals,
      scope,
      [{ ...hit('R4', { runs: 3 }), params: { command: 'pnpm lint' } }],
      T0 + 1000,
      makeId,
    );
    expect(moved.numbers).toBe(true);
    expect(moved.signals[0]?.params).toEqual({ command: 'pnpm lint' });
  });

  it('a broken trigger time becomes now instead of throwing', () => {
    const merged = mergeSignals(
      [],
      scope,
      [{ ...hit('R1b', { waitMin: 20 }), since: NaN }],
      T0,
      makeId,
    );
    expect(merged.signals[0]?.at).toBe(new Date(T0).toISOString());
  });

  it('leaves other chats signals alone', () => {
    const other: GroupSignal = {
      id: 'o',
      rule: 'R4',
      severity: 'warn',
      groupIndex: 2,
      chatId: 'c2',
      at: new Date(T0).toISOString(),
      numbers: {},
      textKey: 'groupWatch.rule.R4',
    };
    const merged = mergeSignals([other], scope, [], T0, makeId);
    expect(merged.structural).toBe(false);
    expect(merged.signals[0]?.clearedAt).toBeUndefined();
    expect(clearChatSignals([other], 'c1', T0).changed).toBe(false);
    expect(clearChatSignals([other], 'c2', T0).signals[0]?.clearedAt).toBeDefined();
  });

  it('caps the list, dropping old cleared ones first', () => {
    const many: GroupSignal[] = Array.from({ length: GROUP_SIGNALS_CAP + 3 }, (_, n) => ({
      id: `x${n}`,
      rule: 'R12',
      severity: 'info',
      groupIndex: 0,
      chatId: `c${n}`,
      at: new Date(T0 + n * 1000).toISOString(),
      numbers: {},
      textKey: 'groupWatch.rule.R12',
      ...(n < 5 ? {} : { clearedAt: new Date(T0 + n * 1000).toISOString() }),
    }));
    const capped = capSignals(many);
    expect(capped).toHaveLength(GROUP_SIGNALS_CAP);
    // Пять самых старых — активные: они остаются, уходят старые закрытые.
    for (let n = 0; n < 5; n++) expect(capped.some((signal) => signal.id === `x${n}`)).toBe(true);
    expect(capped[0]?.id).toBe(`x${GROUP_SIGNALS_CAP + 2}`);
  });

  it('notifies warn and alert only, once per key within the cooldown, again when severity rises', () => {
    const sent = new Map();
    const keyOf = (signal: GroupSignal) => `${signal.rule}:${signal.chatId}`;
    const make = (rule: GroupSignal['rule'], severity: GroupSignal['severity']): GroupSignal => ({
      id: makeId(),
      rule,
      severity,
      groupIndex: 0,
      chatId: 'c1',
      at: '',
      numbers: {},
      textKey: '',
    });
    expect(signalsToNotify([make('R12', 'info')], keyOf, sent, 30 * 60_000, T0)).toHaveLength(0);
    expect(signalsToNotify([make('R4', 'warn')], keyOf, sent, 30 * 60_000, T0)).toHaveLength(1);
    expect(
      signalsToNotify([make('R4', 'warn')], keyOf, sent, 30 * 60_000, T0 + 60_000),
    ).toHaveLength(0);
    expect(
      signalsToNotify([make('R4', 'alert')], keyOf, sent, 30 * 60_000, T0 + 120_000),
    ).toHaveLength(1);
    expect(
      signalsToNotify([make('R4', 'warn')], keyOf, sent, 30 * 60_000, T0 + 31 * 60_000 + 120_000),
    ).toHaveLength(1);
  });
});
