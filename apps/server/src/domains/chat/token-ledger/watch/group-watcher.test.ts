import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import {
  GroupWatcher,
  IDLE_DROP_MS,
  WATCH_TICK_MS,
  type GroupWatcherDeps,
  type WatchTarget,
} from './group-watcher.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

function setup(
  over: {
    settings?: Partial<GroupWatch>;
    status?: SplitPlanGroupRecord['status'];
    ask?: boolean;
    deps?: Partial<GroupWatcherDeps>;
  } = {},
) {
  let now = T0;
  let settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS, ...over.settings };
  const group = { index: 1, title: 'g', status: over.status ?? 'started' } as SplitPlanGroupRecord;
  const saves: string[] = [];
  const notified: Array<{ signal: GroupSignal; target: WatchTarget }> = [];
  let id = 0;
  const watcher = new GroupWatcher({
    settings: () => settings,
    resolve: (chatId) =>
      chatId.startsWith('child')
        ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }
        : undefined,
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: (parent) => saves.push(parent),
    node: () => ({
      running: group.status === 'started',
      paused: group.status === 'paused',
      ...(over.ask ? { ask: { since: T0 } } : {}),
    }),
    notify: (signal, target) => notified.push({ signal, target }),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group] } }),
    ...over.deps,
  });
  return {
    watcher,
    group,
    saves,
    notified,
    at: (t: number) => {
      now = t;
    },
    set: (next: Partial<GroupWatch>) => {
      settings = { ...settings, ...next };
    },
    event: (chatId: string, event: ChatEvent, sessionId = 's1') =>
      watcher.onFeed(chatId, { kind: 'event', event, sessionId }),
  };
}

const check = (n: number): ChatEvent => ({
  kind: 'tool',
  id: `t${n}`,
  name: 'Bash',
  input: { command: 'npx vitest run src/a.test.ts' },
});

describe('GroupWatcher', () => {
  it('turns a repeated check into one signal on the group record, saved and notified once', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * MIN);
      w.event('child-1', check(n));
      w.event('child-1', { kind: 'toolResult', toolUseId: `t${n}`, chars: 10 });
    }
    expect(w.group.watch?.signals).toHaveLength(1);
    expect(w.group.watch?.signals[0]).toMatchObject({
      rule: 'R4',
      chatId: 'child-1',
      stage: 'work',
    });
    expect(w.saves).toEqual(['parent']);
    expect(w.notified.map((entry) => entry.signal.rule)).toEqual(['R4']);
    // Четвёртый прогон — только числа: ни записи на диск сразу, ни второго уведомления.
    w.at(T0 + 4 * MIN);
    w.event('child-1', check(4));
    expect(w.group.watch?.signals[0]?.numbers).toEqual({ runs: 4 });
    expect(w.saves).toEqual(['parent']);
    expect(w.notified).toHaveLength(1);
    // Отложенные числа уходят на тике.
    w.watcher.tick();
    expect(w.saves).toEqual(['parent', 'parent']);
  });

  it('a first-run link under a provisional key moves its signals to the born chat', () => {
    const born = new Map<string, string>();
    const w = setup({
      deps: {
        resolve: (chatId) => ({ chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }),
        canonical: (chatId) => born.get(chatId) ?? chatId,
      },
    });
    w.watcher.onFeed('new-1', { kind: 'start', cwd: '/work/app' });
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * MIN);
      w.event('new-1', check(n));
    }
    expect(w.group.watch?.signals.map((signal) => signal.chatId)).toEqual(['new-1']);
    born.set('new-1', 's1');
    w.at(T0 + 4 * MIN);
    w.event('new-1', check(4));
    // Тот же сигнал под настоящим ключом, без закрытого двойника под временным.
    expect(
      w.group.watch?.signals.map((signal) => [signal.chatId, signal.clearedAt, signal.numbers]),
    ).toEqual([['s1', undefined, { runs: 4 }]]);
  });

  it('ignores chats that are not group links and does nothing when switched off', () => {
    const w = setup();
    w.watcher.onFeed('home', { kind: 'start', sessionId: 'h', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('home', check(n), 'h');
    expect(w.watcher.watched).toBe(0);
    w.set({ enabled: false });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('child-1', check(n));
    expect(w.group.watch).toBeUndefined();
  });

  it('keeps Telegram quiet when the watch telegram switch is off', () => {
    const w = setup({ settings: { telegram: false } });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('child-1', check(n));
    expect(w.group.watch?.signals).toHaveLength(1);
    expect(w.notified).toHaveLength(0);
  });

  it('raises R1 on the tick when a running group falls silent', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.at(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.group.watch?.signals[0]).toMatchObject({ rule: 'R1', severity: 'alert' });
    expect(w.notified.map((entry) => entry.signal.rule)).toEqual(['R1']);
    // Пауза группы снимает условие — сигнал закрыт на следующем тике.
    w.group.status = 'paused';
    w.at(T0 + 26 * MIN);
    w.watcher.tick();
    expect(w.group.watch?.signals[0]?.clearedAt).toBeDefined();
  });

  it('keeps state across runs of one conversation: a resume under a new key sees the cold gap', () => {
    const w = setup();
    w.watcher.onFeed('child-new', { kind: 'start', cwd: '/work/app' });
    w.event('child-new', {
      kind: 'usage',
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheCreation: 100_000,
    });
    w.watcher.onFeed('child-new', { kind: 'finish', sessionId: 's1' });
    w.at(T0 + 70 * MIN);
    w.watcher.onFeed('child-s1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.event('child-s1', {
      kind: 'usage',
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheCreation: 100_000,
    });
    expect(w.group.watch?.signals.map((signal) => signal.rule)).toContain('R2');
  });

  it('forgets a finished group and closes its active signals', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('child-1', check(n));
    w.group.status = 'done';
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
    expect(w.group.watch?.signals[0]?.clearedAt).toBeDefined();
  });

  it('a session dropped after its turn leaves a seed: the cold resume an hour later still shows', () => {
    const w = setup();
    const usage: ChatEvent = {
      kind: 'usage',
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheCreation: 100_000,
    };
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.event('child-1', usage);
    w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
    w.at(T0 + IDLE_DROP_MS + MIN);
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
    w.at(T0 + 70 * MIN);
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.event('child-1', usage);
    expect(w.group.watch?.signals.map((signal) => signal.rule)).toContain('R2');
  });

  it('keeps a finished session whose question still waits for the human', () => {
    const w = setup({ ask: true });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
    w.at(T0 + 16 * MIN);
    w.watcher.tick();
    expect(w.watcher.watched).toBe(1);
    expect(w.group.watch?.signals.map((signal) => signal.rule)).toEqual(['R1b']);
  });

  it('drops a session idle long after its last turn', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
    w.at(T0 + IDLE_DROP_MS + MIN);
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
  });

  it('switched off mid-run: sessions dropped, their active signals closed on the tick', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('child-1', check(n));
    expect(w.group.watch?.signals[0]?.clearedAt).toBeUndefined();
    w.set({ enabled: false });
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
    expect(w.group.watch?.signals[0]?.clearedAt).toBeDefined();
  });

  it('closes active signals nobody watches: at once for a finished group, after the idle span otherwise', () => {
    const stale: GroupSignal = {
      id: 'old',
      rule: 'R4',
      severity: 'warn',
      groupIndex: 1,
      chatId: 'child-old',
      at: new Date(T0 - 60 * MIN).toISOString(),
      numbers: { runs: 3 },
      textKey: 'groupWatch.rule.R4',
    };
    const running = setup();
    running.group.watch = { signals: [{ ...stale }] };
    running.watcher.tick();
    expect(running.group.watch.signals[0]?.clearedAt).toBeUndefined();
    running.at(T0 + IDLE_DROP_MS + MIN);
    running.watcher.tick();
    expect(running.group.watch.signals[0]?.clearedAt).toBeDefined();
    expect(running.saves).toEqual(['parent']);

    const finished = setup({ status: 'done' });
    finished.group.watch = { signals: [{ ...stale }] };
    finished.watcher.tick();
    expect(finished.group.watch.signals[0]?.clearedAt).toBeDefined();
  });

  it('a new conversation under the same chat key rebinds: the old session id no longer maps here', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's2', cwd: '/work/app' });
    w.watcher.onFeed('child-2', { kind: 'start', sessionId: 's2', cwd: '/work/app' });
    expect(w.watcher.watched).toBe(1);
    w.watcher.onFeed('child-3', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    expect(w.watcher.watched).toBe(2);
  });

  it('one broken session does not stop the tick for the others', () => {
    const w = setup({
      deps: {
        node: (target) => {
          if (target.chatId === 'child-bad') throw new Error('store read failed');
          return { running: true, paused: false };
        },
      },
    });
    w.watcher.onFeed('child-bad', { kind: 'start', sessionId: 'sb', cwd: '/work/app' });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.at(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.group.watch?.signals.map((signal) => signal.chatId)).toEqual(['child-1']);
  });

  it('keeps an exhausted-limit session past the idle span while its reset is ahead', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.event('child-1', {
      kind: 'limit',
      status: 'rejected',
      resetsAt: (T0 + 3 * 60 * MIN) / 1000,
    } as ChatEvent);
    w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
    w.at(T0 + IDLE_DROP_MS + MIN);
    w.watcher.tick();
    expect(w.watcher.watched).toBe(1);
    expect(
      w.group.watch?.signals.find((signal) => signal.rule === 'R10')?.clearedAt,
    ).toBeUndefined();
  });

  it('a failed save stays pending and is retried on the next tick', () => {
    let fail = true;
    const saved: string[] = [];
    const w = setup({
      deps: {
        save: (parent) => {
          if (fail) throw new Error('disk full');
          saved.push(parent);
        },
      },
    });
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    for (const n of [1, 2, 3]) w.event('child-1', check(n));
    expect(saved).toEqual([]);
    fail = false;
    w.watcher.tick();
    expect(saved).toEqual(['parent']);
  });

  it('a run adopted without a stream is read from its own transcript, from its end at adoption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-detached-'));
    try {
      const file = join(dir, 's1.jsonl');
      const bash = (n: number, minute: number) =>
        `${JSON.stringify({
          type: 'assistant',
          timestamp: new Date(T0 + minute * MIN).toISOString(),
          message: {
            id: `m${n}`,
            content: [
              {
                type: 'tool_use',
                id: `t${n}`,
                name: 'Bash',
                input: { command: 'npx vitest run src/a.test.ts' },
              },
            ],
          },
        })}\n`;
      // Прошлое до подхвата не догоняется: три старых прогона не в счёт.
      writeFileSync(file, bash(1, -3) + bash(2, -2) + bash(3, -1));
      const w = setup({ deps: { transcript: (id) => (id === 's1' ? file : undefined) } });
      w.watcher.onFeed('child-1', {
        kind: 'start',
        sessionId: 's1',
        cwd: '/work/app',
        detached: true,
      });
      w.at(T0 + MIN);
      w.watcher.tick();
      expect(w.group.watch?.signals ?? []).toEqual([]);
      appendFileSync(file, bash(4, 1) + bash(5, 1) + bash(6, 1));
      w.at(T0 + MIN + WATCH_TICK_MS);
      w.watcher.tick();
      expect(w.group.watch?.signals.map((signal) => signal.rule)).toEqual(['R4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a subagent transcript is read on the tick from its end at bind: its edit resets the repeated check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-subagents-'));
    try {
      const edit = (n: number, minute: number) =>
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          timestamp: new Date(T0 + minute * MIN).toISOString(),
          message: {
            id: `sm${n}`,
            content: [
              {
                type: 'tool_use',
                id: `e${n}`,
                name: 'Edit',
                input: { file_path: '/work/app/src/a.ts' },
              },
            ],
          },
        })}\n`;
      // Правка субагента до привязки — прошлое, не догоняется: повтор проверки виден.
      writeFileSync(join(dir, 'agent-old.jsonl'), edit(1, -1));
      const w = setup({ deps: { subagentDir: (id) => (id === 's1' ? dir : undefined) } });
      w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
      for (const n of [1, 2]) {
        w.at(T0 + n * MIN);
        w.event('child-1', check(n));
      }
      w.at(T0 + 2.5 * MIN);
      w.watcher.tick();
      w.at(T0 + 3 * MIN);
      w.event('child-1', check(3));
      expect(w.group.watch?.signals.map((signal) => signal.rule)).toEqual(['R4']);
      // Новый субагент правит файл — счёт проверок с нуля, сигнал закрыт.
      writeFileSync(join(dir, 'agent-new.jsonl'), edit(2, 3.5));
      w.at(T0 + 4 * MIN);
      w.watcher.tick();
      w.event('child-1', check(4));
      expect(w.group.watch?.signals[0]?.clearedAt).toBeDefined();
      expect(w.group.watch?.signals.filter((signal) => !signal.clearedAt)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
