import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher, IDLE_DROP_MS } from './group-watcher.ts';

/**
 * Пинг тёплого кэша (`keep-warm`) идёт мимо потока и транскрипта сессии, и
 * сторож знает о нём только по `warmed`. Продолжение после пинга читает кэш —
 * R2 (холодная перезапись) на нём не загорается; молчание звена для R1 пинг не
 * прерывает — пинг не работа.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');

function setup(status: SplitPlanGroupRecord['status'] = 'awaiting') {
  let now = T0;
  const group = { index: 1, title: 'g', status } as SplitPlanGroupRecord;
  const watcher = new GroupWatcher({
    settings: () => GROUP_WATCH_DEFAULTS,
    resolve: (chatId) =>
      chatId.startsWith('child')
        ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }
        : undefined,
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: () => {},
    node: () => ({ running: group.status === 'started', paused: group.status === 'paused' }),
    now: () => now,
    plans: () => ({ parent: { groups: [group] } }),
  });
  const event = (chatId: string, payload: ChatEvent) =>
    watcher.onFeed(chatId, { kind: 'event', event: payload, sessionId: 's1' });
  const rules = () => (group.watch?.signals ?? []).map((signal) => signal.rule);
  return {
    watcher,
    group,
    event,
    rules,
    at: (t: number) => {
      now = t;
    },
  };
}

/** Первый ход: всё окно 120k записано в кэш. */
const first: ChatEvent = {
  kind: 'usage',
  input: 10,
  output: 10,
  cacheRead: 0,
  cacheCreation: 120_000,
};
/** Продолжение по тёплому кэшу: окно прочитано, записан хвост. */
const warmResume: ChatEvent = {
  kind: 'usage',
  input: 10,
  output: 10,
  cacheRead: 120_000,
  cacheCreation: 300,
};

function firstTurn(w: ReturnType<typeof setup>): void {
  w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
  w.event('child-1', first);
  w.watcher.onFeed('child-1', { kind: 'finish', sessionId: 's1' });
}

function resumeAt(w: ReturnType<typeof setup>, t: number): void {
  w.at(t);
  w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
  w.event('child-1', warmResume);
}

describe('GroupWatcher и пинг тёплого кэша', () => {
  it('без пинга продолжение через 70 минут — R2 (контроль: проверка умеет краснеть)', () => {
    const w = setup();
    firstTurn(w);
    resumeAt(w, T0 + 70 * MIN);
    expect(w.rules()).toContain('R2');
  });

  it('сессия под наблюдением согрета на 50-й минуте — продолжение на 70-й без R2', () => {
    const w = setup();
    firstTurn(w);
    w.at(T0 + 5 * MIN);
    w.watcher.tick();
    w.watcher.warmed('s1', T0 + 50 * MIN, T0);
    resumeAt(w, T0 + 70 * MIN);
    expect(w.rules()).not.toContain('R2');
  });

  it('сессия уже выпала из наблюдения — отметка ложится в затравку, R2 нет', () => {
    const w = setup();
    firstTurn(w);
    w.at(T0 + IDLE_DROP_MS + MIN);
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
    w.watcher.warmed('s1', T0 + 50 * MIN, T0);
    resumeAt(w, T0 + 70 * MIN);
    expect(w.rules()).not.toContain('R2');
  });

  it('после перезапуска панели (ни сессии, ни затравки) пинг заводит затравку с отметкой', () => {
    const w = setup();
    w.watcher.warmed('s1', T0 + 50 * MIN, T0);
    resumeAt(w, T0 + 70 * MIN);
    expect(w.rules()).not.toContain('R2');
  });

  it('пинг не работа: молчание идущего звена остаётся R1', () => {
    const w = setup('started');
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    w.watcher.warmed('s1', T0 + 10 * MIN, T0);
    w.at(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.rules()).toContain('R1');
  });
});
