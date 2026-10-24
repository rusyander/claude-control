import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher, notifyKey, type WatchTarget } from './group-watcher.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

/**
 * Память отправленного (тихий период): R8 — одна на группу, прочие правила —
 * на чат. Две группы одного разделения: `child-<группа>-<звено>`.
 */
function setup() {
  let now = T0;
  const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS, burnPerHour: 1 };
  const groups = [1, 2].map(
    (index) => ({ index, title: `g${index}`, status: 'started' }) as SplitPlanGroupRecord,
  );
  const notified: string[] = [];
  const watcher = new GroupWatcher({
    settings: () => settings,
    resolve: (chatId) => {
      const match = /^child-(\d)-/.exec(chatId);
      return match
        ? { chatId, parentChatId: 'parent', groupIndex: Number(match[1]), stage: 'work' }
        : undefined;
    },
    group: (parent, index) =>
      parent === 'parent' ? groups.find((group) => group.index === index) : undefined,
    save: () => {},
    node: () => ({ running: true, paused: false }),
    notify: (signal, target) =>
      notified.push(`${signal.rule}@${target.groupIndex}:${signal.chatId}`),
    now: () => now,
    plans: () => ({ parent: { groups } }),
  });
  return {
    watcher,
    notified,
    at: (t: number) => {
      now = t;
    },
    event: (chatId: string, event: ChatEvent, sessionId: string) =>
      watcher.onFeed(chatId, { kind: 'event', event, sessionId }),
  };
}

const check = (id: string): ChatEvent => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: 'npx vitest run src/a.test.ts' },
});

const heavy: ChatEvent = {
  kind: 'usage',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 1_000_000,
  model: 'claude-opus-4-8',
};

describe('GroupWatcher: notification memory keys', () => {
  it('the same rule in two chats of one group: each chat is told, the quiet period is per chat', () => {
    const w = setup();
    for (const chat of ['child-1-a', 'child-1-b']) {
      w.watcher.onFeed(chat, { kind: 'start', sessionId: `s-${chat}`, cwd: '/work/app' });
    }
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * MIN);
      for (const chat of ['child-1-a', 'child-1-b'])
        w.event(chat, check(`${chat}-${n}`), `s-${chat}`);
    }
    // R4 группы ждёт тика плана (F-52): R23 мог свести его по группам.
    w.watcher.tick();
    expect(w.notified.filter((key) => key.startsWith('R4'))).toEqual([
      'R4@1:child-1-a',
      'R4@1:child-1-b',
    ]);
  });

  it('group burn is a note (never sent); its key is still one per group, R9 one per account', () => {
    const w = setup();
    for (const chat of ['child-1-a', 'child-2-a']) {
      w.watcher.onFeed(chat, { kind: 'start', sessionId: `s-${chat}`, cwd: '/work/app' });
    }
    for (const n of [1, 2, 3]) {
      w.at(T0 + n * 1000);
      for (const chat of ['child-1-a', 'child-2-a']) w.event(chat, heavy, `s-${chat}`);
    }
    expect(w.notified.filter((key) => key.startsWith('R8'))).toEqual([]);
    const signal = (rule: GroupSignal['rule'], chatId: string) => ({ rule, chatId }) as GroupSignal;
    const target = (groupIndex: number, chatId: string): WatchTarget => ({
      chatId,
      parentChatId: 'parent',
      groupIndex,
    });
    expect(notifyKey(signal('R8', 'child-1-a'), target(1, 'child-1-a'))).toBe(
      notifyKey(signal('R8', 'child-1-b'), target(1, 'child-1-b')),
    );
    expect(notifyKey(signal('R8', 'child-1-a'), target(1, 'child-1-a'))).not.toBe(
      notifyKey(signal('R8', 'child-2-a'), target(2, 'child-2-a')),
    );
    expect(notifyKey(signal('R9', 'child-1-a'), target(1, 'child-1-a'))).toBe(
      notifyKey(signal('R9', 'child-2-a'), target(2, 'child-2-a')),
    );
  });
});
