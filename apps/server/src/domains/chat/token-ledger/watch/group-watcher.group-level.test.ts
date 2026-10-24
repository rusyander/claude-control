import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  groupSignalsOf,
  type GroupSignal,
  type GroupWatch,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import type { MergeScope } from './signals.ts';
import type { RuleHit } from './watch.types.ts';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupWatcher, type GroupLive, type WatchTarget } from './group-watcher.ts';
import { SignalRecorder } from './group-watcher/signal-recorder.ts';

/**
 * Правила группы (R22, R28) и плана (R23) на тике сторожа: обход идёт по каждой живой
 * группе разделения, с сессией или без, — через настоящий `GroupWatcher` и его запись
 * сигналов. Подменены только ответы проводки: записи плана, живость группы, часы.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T10:00:00Z');
const IDLE: GroupLive = { running: false, ask: false, queued: false, paused: false };

const held = (rule: GroupSignal['rule'], index: number, minute: number, call: string) => ({
  id: `${rule}-${index}`,
  rule,
  severity: 'warn' as const,
  groupIndex: index,
  chatId: `child-${index}`,
  at: new Date(T0 + minute * MIN).toISOString(),
  numbers: {},
  textKey: `groupWatch.rule.${rule}`,
  params: { call, error: 'exit 1' },
});

function setup(options: { groups?: number; settings?: Partial<GroupWatch> } = {}) {
  let now = T0;
  let live: GroupLive = IDLE;
  const groups = Array.from(
    { length: options.groups ?? 1 },
    (_, i) =>
      ({
        index: i + 1,
        title: `g${i + 1}`,
        status: 'started',
        chatId: `child-${i + 1}`,
      }) as SplitPlanGroupRecord,
  );
  const notified: Array<{ signal: GroupSignal; target: WatchTarget }> = [];
  const asked: string[][] = [];
  const watcher = new GroupWatcher({
    settings: () => ({ ...GROUP_WATCH_DEFAULTS, ...options.settings }),
    resolve: (chatId) => {
      const index = Number(chatId.replace('child-', ''));
      return groups.some((group) => group.index === index)
        ? { chatId, parentChatId: 'parent', groupIndex: index }
        : undefined;
    },
    group: (parent, index) =>
      parent === 'parent' ? groups.find((group) => group.index === index) : undefined,
    save: () => {},
    node: () => ({ running: true, paused: false }),
    transcript: () => undefined,
    notify: (signal, target) => notified.push({ signal, target }),
    now: () => now,
    makeId: () => `id-${notified.length}`,
    plans: () => ({ parent: { groups } }),
    groupLive: (_parent, _group, keys) => {
      asked.push([...keys]);
      return live;
    },
  });
  return {
    watcher,
    groups,
    notified,
    asked,
    at: (minute: number) => {
      now = T0 + minute * MIN;
      watcher.tick();
    },
    setLive: (patch: Partial<GroupLive>) => {
      live = { ...IDLE, ...patch };
    },
    active: (index: number, rule: string) =>
      groupSignalsOf(groups[index - 1]?.watch).filter(
        (signal) => signal.rule === rule && !signal.clearedAt,
      ),
  };
}

describe('GroupWatcher R22 группа стоит без хода (тик сторожа)', () => {
  it('ни сессии, ни прогона: 25 мин — внимание и сообщение, 65 мин — тревога и второе сообщение', () => {
    const w = setup();
    w.at(10);
    expect(w.active(1, 'R22')).toEqual([]);
    w.at(25);
    expect(w.active(1, 'R22')).toMatchObject([
      { severity: 'warn', numbers: { idleMin: 25 }, params: { why: 'no-run' }, chatId: 'child-1' },
    ]);
    w.at(65);
    expect(w.active(1, 'R22')).toMatchObject([{ severity: 'alert', numbers: { idleMin: 65 } }]);
    expect(w.notified.map(({ signal }) => [signal.rule, signal.severity])).toEqual([
      ['R22', 'warn'],
      ['R22', 'alert'],
    ]);
    expect(w.notified[0]?.target).toEqual({
      chatId: 'child-1',
      parentChatId: 'parent',
      groupIndex: 1,
    });
  });

  it('пинг тёплого кэша — не ход: часы тишины не сбрасывает', () => {
    const w = setup();
    w.at(20);
    w.watcher.warmed('s-1', T0 + 20 * MIN, T0);
    w.at(25);
    expect(w.active(1, 'R22')).toHaveLength(1);
  });

  it('старт прогона звена гасит R22 на ближайшем тике; группа с прогоном — молчит', () => {
    const w = setup();
    w.at(25);
    expect(w.active(1, 'R22')).toHaveLength(1);
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's-1', cwd: '/work/app' });
    // Живость ещё «стоит» (реестр не успел) — гасит сама отметка голоса группы на старте.
    w.at(26);
    expect(w.active(1, 'R22')).toEqual([]);
    w.setLive({ running: true });
    w.at(60);
    expect(w.active(1, 'R22')).toEqual([]);
    // Живость спрошена по ключам звена под наблюдением.
    expect(w.asked.at(-1)).toContain('child-1');
  });

  it('сторож выключен — правила группы не считаются, R22 закрыт', () => {
    const settings: Partial<GroupWatch> = {};
    const w = setup({ settings });
    w.at(25);
    expect(w.active(1, 'R22')).toHaveLength(1);
    settings.enabled = false;
    w.at(26);
    expect(w.active(1, 'R22')).toEqual([]);
  });
});

describe('GroupWatcher R23 одна беда в нескольких группах плана', () => {
  it('одинаковое падение в двух группах — R23 на обеих, сообщение одно на план', () => {
    const w = setup({ groups: 3 });
    w.setLive({ running: true });
    w.groups[0]!.watch = { signals: [held('R24', 1, 0, 'cd /w/.copies/g1 && pnpm test')] };
    w.groups[1]!.watch = { signals: [held('R24', 2, 30, 'pnpm test')] };
    w.groups[2]!.watch = { signals: [held('R24', 3, 30, 'pnpm lint')] };
    w.at(31);
    expect(w.active(1, 'R23')).toMatchObject([
      { severity: 'alert', numbers: { groups: 2, spanMin: 30 }, params: { command: 'pnpm test' } },
    ]);
    expect(w.active(2, 'R23')).toHaveLength(1);
    expect(w.active(3, 'R23')).toEqual([]);
    expect(w.notified.map(({ signal }) => signal.rule)).toEqual(['R23']);
    // Повторный тик — без второго сообщения.
    w.at(32);
    expect(w.notified).toHaveLength(1);
    // Падение во второй группе закрылось — R23 гаснет на обеих.
    w.groups[1]!.watch = { signals: [] };
    w.at(33);
    expect(w.active(1, 'R23')).toEqual([]);
  });

  it('F-91: группа на паузе в беде плана не участвует; сняли с паузы — R23 снова считается', () => {
    const w = setup({ groups: 2 });
    w.setLive({ running: true });
    w.groups[0]!.watch = { signals: [held('R24', 1, 0, 'pnpm test')] };
    w.groups[1]!.watch = { signals: [held('R24', 2, 5, 'pnpm test')] };
    w.groups[1]!.status = 'paused';
    w.at(6);
    expect(w.active(1, 'R23')).toEqual([]);
    expect(w.active(2, 'R23')).toEqual([]);
    expect(w.notified.map(({ signal }) => signal.rule)).not.toContain('R23');
    w.groups[1]!.status = 'started';
    w.at(7);
    expect(w.active(1, 'R23')).toHaveLength(1);
    expect(w.active(2, 'R23')).toHaveLength(1);
  });
});

/**
 * F-52: R23 считается на тике, а R24/R15/R16 групп поднимаются раньше — в ходе.
 * Сообщение о повторяющейся беде групп ждёт тика плана: накрыл её R23 — одно сообщение.
 */
describe('GroupWatcher R23: одно сообщение на план, а не по группам (F-52)', () => {
  const failing = (
    w: ReturnType<typeof setup>,
    index: number,
    command = 'curl -sf http://127.0.0.1:5178/api/health',
  ): void => {
    const chatId = `child-${index}`;
    for (const n of [0, 1]) {
      const id = `t${index}-${n}-${command.length}`;
      w.watcher.onFeed(chatId, {
        kind: 'event',
        sessionId: `s-${index}`,
        event: { kind: 'tool', id, name: 'Bash', input: { command } },
      });
      w.watcher.onFeed(chatId, {
        kind: 'event',
        sessionId: `s-${index}`,
        event: {
          kind: 'toolResult',
          toolUseId: id,
          chars: 40,
          isError: true,
          errorHead: 'curl: (7) Failed to connect',
        },
      });
    }
  };

  it('то же падение в двух группах за один тик — наружу только R23; другая беда — своё сообщение', () => {
    const w = setup({ groups: 3, settings: { errorRepeats: 2 } });
    w.setLive({ running: true });
    for (const index of [1, 2, 3]) {
      w.watcher.onFeed(`child-${index}`, { kind: 'start', sessionId: `s-${index}`, cwd: '/w' });
    }
    failing(w, 1);
    failing(w, 2);
    expect(w.active(1, 'R24')).toHaveLength(1);
    expect(w.active(2, 'R24')).toHaveLength(1);
    w.at(2);
    expect(w.active(1, 'R23')).toHaveLength(1);
    expect(w.notified.map(({ signal }) => signal.rule)).toEqual(['R23']);
    // Беда только в одной группе — R23 её не накрыл: своё сообщение на ближайшем тике.
    failing(w, 3, 'curl -sf http://127.0.0.1:9999/x');
    expect(w.active(3, 'R24')).toHaveLength(1);
    expect(w.notified).toHaveLength(1);
    w.at(3);
    expect(w.notified.map(({ signal, target }) => [signal.rule, target.groupIndex])).toEqual([
      ['R23', 1],
      ['R24', 3],
    ]);
  });
});

describe('SignalRecorder: застрявший вызов под R23 плана', () => {
  it('R15 с той же командой, что у активного R23, — строка есть, сообщения нет; другая команда — сообщение', () => {
    const groups = [1, 2].map(
      (index) => ({ index, title: `g${index}`, status: 'started' }) as SplitPlanGroupRecord,
    );
    const notified: string[] = [];
    const deps = {
      settings: () => GROUP_WATCH_DEFAULTS,
      resolve: () => undefined,
      group: (_parent: string, index: number) => groups.find((group) => group.index === index),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      notify: (signal: GroupSignal) => notified.push(`${signal.rule}:${signal.groupIndex}`),
      makeId: () => 'id',
      plans: () => ({ parent: { groups } }),
    };
    const recorder = new SignalRecorder(deps, T0);
    const target = (index: number): WatchTarget => ({
      chatId: `child-${index}`,
      parentChatId: 'parent',
      groupIndex: index,
    });
    recorder.record(target(1), GROUP_WATCH_DEFAULTS, T0, [
      {
        hits: [
          {
            rule: 'R23',
            severity: 'alert',
            numbers: { groups: 2, spanMin: 5 },
            params: { command: 'pnpm test:e2e' },
            since: T0,
          },
        ],
        merge: { rules: new Set<GroupWatchRule>(['R23']), group: true },
      },
    ]);
    expect(notified).toEqual(['R23:1']);
    const stuck = (call: string): { hits: RuleHit[]; merge: MergeScope } => ({
      hits: [{ rule: 'R15', severity: 'warn', numbers: { min: 12 }, params: { call }, since: T0 }],
      merge: { rules: new Set<GroupWatchRule>(['R15']) },
    });
    recorder.record(target(2), GROUP_WATCH_DEFAULTS, T0 + MIN, [
      stuck('cd /w/.copies/g2 && pnpm test:e2e'),
    ]);
    expect(recorder.signalsOf('parent', 2).map((signal) => signal.rule)).toEqual(['R15']);
    recorder.releasePending(GROUP_WATCH_DEFAULTS, T0 + MIN);
    expect(notified).toEqual(['R23:1']);
    // Другая команда ждёт тика плана: R23 её не накрыл — сообщение на тике.
    recorder.record(target(1), GROUP_WATCH_DEFAULTS, T0 + 2 * MIN, [stuck('pnpm lint')]);
    expect(notified).toEqual(['R23:1']);
    recorder.releasePending(GROUP_WATCH_DEFAULTS, T0 + 2 * MIN);
    expect(notified).toEqual(['R23:1', 'R15:1']);
  });
});

describe('SignalRecorder.moveChat: переезд сигналов на настоящий ключ — слиянием (F-107)', () => {
  it('правило уже активно под новым ключом — после переезда одна активная строка, не две', () => {
    const groups = [{ index: 1, title: 'g1', status: 'started' } as SplitPlanGroupRecord];
    const deps = {
      settings: () => GROUP_WATCH_DEFAULTS,
      resolve: () => undefined,
      group: (_parent: string, index: number) => groups.find((group) => group.index === index),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      notify: () => {},
      makeId: () => `id-${Math.random()}`,
      plans: () => ({ parent: { groups } }),
    };
    const recorder = new SignalRecorder(deps, T0);
    const stuck = (chatId: string, call: string) =>
      recorder.record({ chatId, parentChatId: 'parent', groupIndex: 1 }, GROUP_WATCH_DEFAULTS, T0, [
        {
          hits: [
            { rule: 'R15', severity: 'warn', numbers: { min: 12 }, params: { call }, since: T0 },
          ],
          merge: { rules: new Set<GroupWatchRule>(['R15']) },
        },
      ]);
    stuck('temp-key', 'pnpm test');
    stuck('real-key', 'pnpm test');
    recorder.moveChat(
      { chatId: 'temp-key', parentChatId: 'parent', groupIndex: 1 },
      'temp-key',
      'real-key',
    );
    const active = recorder
      .signalsOf('parent', 1)
      .filter((signal) => signal.rule === 'R15' && !signal.clearedAt);
    expect(active.map((signal) => signal.chatId)).toEqual(['real-key']);
  });
});
