import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher } from './group-watcher.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T07:30:00Z');

/**
 * Сторож целиком (поток → свёртка → правила → сигналы записи группы) на пропусках
 * 23.10: активность на паузе (R20) и снятие прочих сигналов паузой, полные гейты по
 * кругу в разных разговорах одной группы (R21), мигание расхода у порога (R8).
 */
function setup(settings: Partial<GroupWatch> = {}) {
  let now = T0;
  const group = { index: 8, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const notified: GroupSignal[] = [];
  let id = 0;
  const watcher = new GroupWatcher({
    settings: () => ({ ...GROUP_WATCH_DEFAULTS, ...settings }),
    resolve: (chatId) =>
      chatId.startsWith('child')
        ? {
            chatId,
            parentChatId: 'parent',
            groupIndex: 8,
            stage: chatId.endsWith('deliver') ? 'deliver' : 'work',
          }
        : undefined,
    group: (parent, index) => (parent === 'parent' && index === 8 ? group : undefined),
    save: () => {},
    node: () => ({
      running: group.status === 'started',
      paused: group.status === 'paused',
      ...(group.pausedAt ? { pausedAt: Date.parse(group.pausedAt) } : {}),
    }),
    notify: (signal) => notified.push(signal),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group] } }),
  });
  return {
    watcher,
    group,
    notified,
    at: (t: number) => {
      now = t;
    },
    start: (chatId: string, sessionId: string) =>
      watcher.onFeed(chatId, { kind: 'start', sessionId, cwd: '/work/app' }),
    event: (chatId: string, event: ChatEvent, sessionId: string) =>
      watcher.onFeed(chatId, { kind: 'event', event, sessionId }),
    signals: () => group.watch?.signals ?? [],
    active: () =>
      (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt).map((s) => s.rule),
  };
}

const bash = (id: string, command: string, extra: Record<string, unknown> = {}): ChatEvent => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command, ...extra },
});
const result = (id: string, extra: Partial<Extract<ChatEvent, { kind: 'toolResult' }>> = {}) =>
  ({ kind: 'toolResult', toolUseId: id, chars: 100, ...extra }) as ChatEvent;

const GATE =
  'node ../.claude/tools/check-ticket.mjs > ../.agent/tmp/gates.log 2>&1; echo "exit $?"';

describe('GroupWatcher: pause (R20)', () => {
  it('пауза закрывает сигналы группы; разбуженная на паузе сессия — тревога R20; снятие паузы её закрывает', () => {
    const w = setup();
    w.start('child-1', 's1');
    // Гейт упёрся в срок 30 мин и ушёл в фон (как у #8 в 08:07:42) — R15.
    w.event('child-1', bash('g1', GATE, { timeout: 1_800_000 }), 's1');
    w.at(T0 + 30 * MIN);
    w.event('child-1', result('g1', { timedOutMs: 1_800_000 }), 's1');
    w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
    expect(w.active()).toContain('R15');

    // Пауза группы: следующий тик закрывает R15 — его срок держания ещё не вышел.
    w.at(T0 + 35 * MIN);
    w.group.status = 'paused';
    w.group.pausedAt = new Date(T0 + 35 * MIN).toISOString();
    w.watcher.tick();
    expect(w.active()).toEqual([]);

    // Через 4 минуты фоновая задача будит CLI: новый ход, коммит, worktree.
    w.at(T0 + 39 * MIN);
    w.start('child-1', 's1');
    w.event('child-1', bash('c1', 'git add -A && git commit -q -F ../.agent/tmp/msg.txt'), 's1');
    w.event('child-1', result('c1'), 's1');
    w.event('child-1', bash('c2', 'git worktree add ../.agent/tmp/combocheck HEAD'), 's1');
    expect(w.active()).toEqual(['R20']);
    const r20 = w.signals().find((signal) => signal.rule === 'R20');
    expect(r20).toMatchObject({ severity: 'alert', numbers: { tools: 2, afterMin: 4 } });
    expect(r20?.params?.call).toContain('git worktree add');
    expect(w.notified.map((signal) => signal.rule)).toContain('R20');
    // R15 не вернулся вторым рядом.
    expect(w.signals().filter((signal) => signal.rule === 'R15')).toHaveLength(1);

    // Группу сняли с паузы — условие кончилось.
    w.at(T0 + 41 * MIN);
    w.group.status = 'started';
    delete w.group.pausedAt;
    w.watcher.tick();
    expect(w.active()).not.toContain('R20');
    // Повод R15 был до паузы: после неё он не поднимается заново вторым рядом.
    expect(w.signals().filter((signal) => signal.rule === 'R15')).toHaveLength(1);
    expect(w.active()).toEqual([]);
  });
});

describe('GroupWatcher: heavy checks per group (R21)', () => {
  it('полный гейт в работе и ещё один в доставке — «внимание» на группу; R4 молчит из-за правки между', () => {
    const w = setup();
    w.start('child-work', 'sw');
    w.event('child-work', bash('a', GATE), 'sw');
    w.at(T0 + 12 * MIN);
    w.event('child-work', result('a'), 'sw');
    w.event(
      'child-work',
      { kind: 'tool', id: 'e', name: 'Edit', input: { file_path: 'a.ts' } },
      'sw',
    );
    w.event('child-work', result('e'), 'sw');
    expect(w.active()).toEqual([]);

    w.at(T0 + 20 * MIN);
    w.start('child-deliver', 'sd');
    w.event('child-deliver', bash('b', GATE), 'sd');
    w.at(T0 + 33 * MIN);
    w.event('child-deliver', result('b'), 'sd');
    expect(w.active()).toEqual(['R21']);
    const r21 = w.signals().find((signal) => signal.rule === 'R21');
    expect(r21).toMatchObject({
      severity: 'warn',
      chatId: 'child-deliver',
      numbers: { gates: 2, totalMin: 25 },
    });
    expect(w.notified.map((signal) => signal.rule)).toEqual(['R21']);
  });

  it('отбитый стражем гейт и короткий повтор из журнала проверок не в счёт; порог 3 — тишина', () => {
    const w = setup();
    w.start('child-work', 'sw');
    w.event('child-work', bash('a', GATE), 'sw');
    w.at(T0 + 12 * MIN);
    w.event('child-work', result('a'), 'sw');
    w.event('child-work', bash('b', GATE), 'sw');
    w.event('child-work', result('b', { denied: 'gate-at-end' }), 'sw');
    w.event('child-work', bash('c', GATE), 'sw');
    w.at(T0 + 12 * MIN + 10_000);
    w.event('child-work', result('c'), 'sw');
    expect(w.active()).toEqual([]);

    const quiet = setup({ gateRepeats: 3 });
    quiet.start('child-work', 'sw');
    for (const [n, from] of [0, 15].entries()) {
      quiet.at(T0 + from * MIN);
      quiet.event('child-work', bash(`g${n}`, GATE), 'sw');
      quiet.at(T0 + (from + 10) * MIN);
      quiet.event('child-work', result(`g${n}`), 'sw');
    }
    expect(quiet.active()).toEqual([]);
  });

  it('гейт в фоне — тяжёлый сразу: длительность хода его не меряет', () => {
    const w = setup();
    w.start('child-work', 'sw');
    for (const n of [1, 2]) {
      w.at(T0 + n * MIN);
      w.event('child-work', bash(`g${n}`, GATE, { run_in_background: true }), 'sw');
      w.event('child-work', result(`g${n}`), 'sw');
    }
    expect(w.active()).toEqual(['R21']);
  });
});

describe('GroupWatcher: pause clears group ledgers (F-51)', () => {
  it('два гейта до паузы, пауза, снятие через 5 мин и новый ход — R21 не поднимается вторым рядом', () => {
    const w = setup();
    w.start('child-work', 'sw');
    for (const [n, from] of [0, 15].entries()) {
      w.at(T0 + from * MIN);
      w.event('child-work', bash(`g${n}`, GATE), 'sw');
      w.at(T0 + (from + 10) * MIN);
      w.event('child-work', result(`g${n}`), 'sw');
    }
    expect(w.active()).toEqual(['R21']);

    w.at(T0 + 30 * MIN);
    w.group.status = 'paused';
    w.group.pausedAt = new Date(T0 + 30 * MIN).toISOString();
    w.watcher.tick();
    expect(w.active()).toEqual([]);

    w.at(T0 + 35 * MIN);
    w.group.status = 'started';
    delete w.group.pausedAt;
    w.watcher.tick();
    w.start('child-work', 'sw');
    w.event('child-work', bash('e', 'git status'), 'sw');
    w.event('child-work', result('e'), 'sw');
    expect(w.active()).toEqual([]);
    expect(w.signals().filter((signal) => signal.rule === 'R21')).toHaveLength(1);
    expect(w.notified.map((signal) => signal.rule)).toEqual(['R21']);
  });
});

describe('GroupWatcher: single chat feeds no group ledgers (F-78)', () => {
  it('два гейта и тяжёлый расход в одиночном чате — списки R8/R21 пусты, сигналов нет', () => {
    let now = T0;
    const watcher = new GroupWatcher({
      settings: () => GROUP_WATCH_DEFAULTS,
      resolve: (chatId) => ({ scope: 'chat', chatId, parentChatId: chatId, groupIndex: -1 }),
      group: () => undefined,
      save: () => {},
      node: () => ({ running: true, paused: false }),
      now: () => now,
      plans: () => ({}),
    });
    const feed = (event: ChatEvent) =>
      watcher.onFeed('chat-1', { kind: 'event', event, sessionId: 'sc' });
    watcher.onFeed('chat-1', { kind: 'start', sessionId: 'sc', cwd: '/work/app' });
    for (const [n, from] of [0, 15].entries()) {
      now = T0 + from * MIN;
      feed(bash(`g${n}`, GATE));
      feed({
        kind: 'usage',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 2_000_000,
        model: 'claude-opus-4-8',
      });
      now = T0 + (from + 10) * MIN;
      feed(result(`g${n}`));
    }
    const ledgers = (
      watcher as unknown as {
        ledgers: { heavyOf(key: string): unknown[]; burnOf(key: string): unknown[] };
      }
    ).ledgers;
    expect(ledgers.heavyOf('chat-1#-1')).toEqual([]);
    expect(ledgers.burnOf('chat-1#-1')).toEqual([]);
  });
});

describe('GroupWatcher: R8 at the threshold', () => {
  /** Вызов на W: 1M записи кэша на Opus 4.8 — 6.25 W. */
  const call = (weight: number): ChatEvent => ({
    kind: 'usage',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: Math.round((weight / 6.25) * 1_000_000),
    model: 'claude-opus-4-8',
  });

  it('расход 40.8 → 39.6 → 40.4 W/ч — один сигнал, а не новый на каждое пересечение', () => {
    const w = setup();
    w.start('child-1', 's1');
    for (const [t, weight] of [
      [0, 3.4],
      [1, 3.4],
      [2, 3.4],
      [16, 3.1],
      [17, 3.6],
    ] as const) {
      w.at(T0 + t * MIN);
      w.event('child-1', call(weight), 's1');
    }
    const r8 = w.signals().filter((signal) => signal.rule === 'R8');
    expect(r8).toHaveLength(1);
    expect(r8[0]?.clearedAt).toBeUndefined();
    // Поток кончился: окно опустело — закрыт.
    w.at(T0 + 40 * MIN);
    w.watcher.tick();
    expect(w.signals().filter((signal) => signal.rule === 'R8' && !signal.clearedAt)).toEqual([]);
  });
});
