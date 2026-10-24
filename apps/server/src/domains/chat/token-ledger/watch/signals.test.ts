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

  it('over the cap with only active signals: none is evicted, the oldest is not raised again', () => {
    const active: GroupSignal[] = Array.from({ length: GROUP_SIGNALS_CAP + 1 }, (_, n) => ({
      id: `a${n}`,
      rule: n % 2 === 0 ? 'R4' : 'R12',
      severity: 'warn',
      groupIndex: 0,
      chatId: `c${n}`,
      at: new Date(T0 + n * 1000).toISOString(),
      numbers: { runs: 3 },
      textKey: '',
    }));
    expect(capSignals(active)).toHaveLength(GROUP_SIGNALS_CAP + 1);
    // Самый старый активный (c0) остаётся и на следующей оценке находится, а не рождается заново.
    const merged = mergeSignals(
      active,
      { chatId: 'c0', groupIndex: 0 },
      [hit('R4', { runs: 3 })],
      T0 + 60_000,
      makeId,
    );
    expect(merged.raised).toEqual([]);
    expect(merged.structural).toBe(false);
    expect(merged.signals.find((signal) => signal.chatId === 'c0')?.id).toBe('a0');
  });

  it('merge scope: rules limit what is raised and closed, group scope finds the one signal by rule', () => {
    const base = mergeSignals(
      [],
      scope,
      [hit('R4', { runs: 3 }), hit('R8', { perHour: 50 })],
      T0,
      makeId,
    );
    // Слияние правил сессии не трогает сигнал группы R8, даже когда в попаданиях его нет.
    const session = mergeSignals(base.signals, scope, [hit('R4', { runs: 4 })], T0 + 1, makeId, {
      rules: new Set(['R4']),
    });
    expect(session.signals.find((signal) => signal.rule === 'R8')?.clearedAt).toBeUndefined();
    // Сигнал группы ищется по правилу: другой чат того же звена обновляет его, а не заводит второй.
    const other = { ...scope, chatId: 'c-review' };
    const group = mergeSignals(
      session.signals,
      other,
      [hit('R8', { perHour: 70 })],
      T0 + 2,
      makeId,
      { rules: new Set(['R8']), group: true },
    );
    expect(group.raised).toEqual([]);
    expect(group.signals.filter((signal) => signal.rule === 'R8')).toHaveLength(1);
    expect(group.signals.find((signal) => signal.rule === 'R8')?.numbers).toEqual({ perHour: 70 });
    // Условие группы кончилось — закрыт из любого чата, R4 чата c1 не тронут.
    const quiet = mergeSignals(group.signals, other, [], T0 + 3, makeId, {
      rules: new Set(['R8']),
      group: true,
    });
    expect(quiet.signals.find((signal) => signal.rule === 'R8')?.clearedAt).toBeDefined();
    expect(quiet.signals.find((signal) => signal.rule === 'R4')?.clearedAt).toBeUndefined();
  });

  it('clearChatSignals with rules closes only those rules of the chat', () => {
    const both = mergeSignals(
      [],
      scope,
      [hit('R4', { runs: 3 }), hit('R8', { perHour: 50 })],
      T0,
      makeId,
    );
    const cleared = clearChatSignals(both.signals, 'c1', T0 + 1, new Set(['R4']));
    expect(cleared.changed).toBe(true);
    expect(cleared.signals.find((signal) => signal.rule === 'R4')?.clearedAt).toBeDefined();
    expect(cleared.signals.find((signal) => signal.rule === 'R8')?.clearedAt).toBeUndefined();
    // Закрытый не закрывается второй раз.
    expect(clearChatSignals(cleared.signals, 'c1', T0 + 2, new Set(['R4'])).changed).toBe(false);
  });

  it('notifies warn and alert only, once per key within the cooldown unless the severity rose', () => {
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
    // Важность выросла (внимание → тревога) — наружу сразу, срок тишины её не держит (C02);
    // та же тревога ещё раз внутри срока — нет.
    expect(
      signalsToNotify([make('R4', 'alert')], keyOf, sent, 30 * 60_000, T0 + 120_000),
    ).toHaveLength(1);
    expect(
      signalsToNotify([make('R4', 'alert')], keyOf, sent, 30 * 60_000, T0 + 180_000),
    ).toHaveLength(0);
    expect(
      signalsToNotify([make('R1', 'alert')], keyOf, sent, 30 * 60_000, T0 + 120_000),
    ).toHaveLength(1);
    expect(
      signalsToNotify([make('R4', 'warn')], keyOf, sent, 30 * 60_000, T0 + 31 * 60_000 + 120_000),
    ).toHaveLength(1);
  });

  it('a hit with a higher severity raises the active signal in place and offers it again (A2)', () => {
    const warn = mergeSignals([], scope, [hit('R1b', { waitMin: 20 })], T0, makeId);
    const id = warn.signals[0]?.id;
    const same = mergeSignals(warn.signals, scope, [hit('R1b', { waitMin: 40 })], T0 + 1, makeId);
    expect(same.raised).toEqual([]);
    expect(same.structural).toBe(false);
    const alert = mergeSignals(
      same.signals,
      scope,
      [hit('R1b', { waitMin: 61 }, 'alert')],
      T0 + 2,
      makeId,
    );
    expect(alert.signals).toHaveLength(1);
    expect(alert.signals[0]).toMatchObject({ id, severity: 'alert', numbers: { waitMin: 61 } });
    expect(alert.raised.map((signal) => signal.id)).toEqual([id]);
    expect(alert.structural).toBe(true);
    // Вниз не идёт: тревога держится, пока условие не кончится.
    const lower = mergeSignals(alert.signals, scope, [hit('R1b', { waitMin: 62 })], T0 + 3, makeId);
    expect(lower.signals[0]?.severity).toBe('alert');
    expect(lower.raised).toEqual([]);
  });
});
