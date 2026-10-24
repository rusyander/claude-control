import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  groupSignalsOf,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { wireGroupWatch, type GroupWatchWiringDeps } from './group-watch-wiring.ts';

/**
 * Проводка сторожа для одиночного чата (A1) и правил группы (R22): реестр прогонов →
 * сторож → правила → срез хранилища панели во временном каталоге. Подменён только
 * процесс CLI — события подаёт тест.
 */

const T0 = Date.parse('2026-10-23T10:00:00Z');
const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let emit: ((event: ChatEvent) => void) | undefined;
class EmittingRun implements RunLike {
  pid = 4242;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    emit = onEvent;
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

const TRIAGE: ChatLink = {
  parentChatId: 'parent',
  stage: 'triage',
  createdAt: '2026-10-23',
} as ChatLink;

function wire(
  options: {
    settings?: Partial<GroupWatch>;
    links?: Record<string, ChatLink>;
    extra?: Partial<GroupWatchWiringDeps>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-chat-'));
  dirs.push(dir);
  const store = new AppStore(dir);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: '/work/app',
    createdAt: '2026-10-23T10:00:00.000Z',
    groups: [{ index: 1, title: 'g', status: 'started', path: '/work/app/.copies/g1' }],
  } as unknown as SplitPlanRecord);
  const links: Record<string, ChatLink> = {
    'child-1': { parentChatId: 'parent', groupIndex: 1, stage: 'work', createdAt: '2026-10-23' },
    ...options.links,
  };
  const changed: string[] = [];
  const registry = new ChatRunRegistry(() => new EmittingRun());
  const watcher = wireGroupWatch(registry, {
    settings: () => ({ ...GROUP_WATCH_DEFAULTS, ...options.settings }),
    link: (chatId) => links[chatId],
    links: () => links,
    plan: (parent) => store.getSplitPlan(parent),
    plans: () => store.getSplitPlans(),
    signals: {
      get: (parent, index) => store.getGroupWatchSignals(parent, index),
      set: (parent, index, block) => store.putGroupWatchSignals(parent, index, block),
      all: () => store.getAllGroupWatchSignals(),
      save: () => store.saveGroupWatchSignals(),
    },
    chatSignals: {
      get: (chatId) => store.getChatWatchSignals(chatId),
      set: (chatId, record) => store.putChatWatchSignals(chatId, record),
      all: () => store.getAllChatWatchSignals(),
    },
    chatChanged: (chatId) => changed.push(chatId),
    asksOf: () => [],
    projectsDir: () => dir,
    heavyQueueDir: dir,
    ...options.extra,
  });
  const chatSignals = (chatId: string): GroupSignal[] =>
    groupSignalsOf(store.getChatWatchSignals(chatId));
  const groupSignals = (): GroupSignal[] => groupSignalsOf(store.getGroupWatchSignals('parent', 1));
  return { registry, watcher, store, chatSignals, groupSignals, changed, dir };
}

/**
 * Три одинаковых падения одного скрипта — повтор той же ошибки (R24, порог 3). Скрипт
 * не тяжёлый: повтор тяжёлой проверки назвал бы R4, и R24 при нём молчит (тот же круг).
 */
function failThrice(): void {
  for (const n of [1, 2, 3]) {
    emit?.({
      kind: 'tool',
      id: `t${n}`,
      name: 'Bash',
      input: { command: 'node scripts/seed.mjs' },
    });
    emit?.({
      kind: 'toolResult',
      toolUseId: `t${n}`,
      isError: true,
      errorKind: 'exit',
      errorHead: 'exit 1: 2 failed',
    });
  }
}

const start = (registry: ChatRunRegistry, chatId: string) =>
  registry.start(chatId, { prompt: 'задача', cwd: '/work/app' }, { origin: 'chat' });

describe('wireGroupWatch одиночный чат (A1)', () => {
  it('прогон без связи с деревом: три одинаковых падения — R24 в срезе чата, строка чата перечитывается', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire();
    start(w.registry, 'chat-1');
    failThrice();
    w.watcher.tick();
    expect(w.chatSignals('chat-1')).toMatchObject([
      { rule: 'R24', chatId: 'chat-1', numbers: { fails: 3 } },
    ]);
    expect(w.changed).toContain('chat-1');
    expect(w.groupSignals().some((signal) => signal.rule === 'R24')).toBe(false);
    // Перезапуск панели: сигнал читается с диска.
    const reloaded = new AppStore(w.dir);
    expect(groupSignalsOf(reloaded.getChatWatchSignals('chat-1')).map((s) => s.rule)).toEqual([
      'R24',
    ]);
    w.watcher.stop();
  });

  it('служебный прогон панели (вопрос о ходе групп) — не чат человека: ничего', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire({ extra: { internal: (keys) => keys.includes('status-1') } });
    start(w.registry, 'status-1');
    failThrice();
    w.watcher.tick();
    expect(w.store.getAllChatWatchSignals()).toEqual({});
    expect(w.changed).toEqual([]);
    w.watcher.stop();
  });

  it('разговор разбора (связь без группы) — не одиночный чат: ничего', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire({ links: { 'triage-1': TRIAGE } });
    start(w.registry, 'triage-1');
    failThrice();
    w.watcher.tick();
    expect(w.store.getAllChatWatchSignals()).toEqual({});
    w.watcher.stop();
  });

  it('`singleChats` выключен — как до A1: ничего', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire({ settings: { singleChats: false } });
    start(w.registry, 'chat-1');
    failThrice();
    w.watcher.tick();
    expect(w.store.getAllChatWatchSignals()).toEqual({});
    w.watcher.stop();
  });

  it('звено группы по-прежнему пишет в запись группы, не в срез чатов', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire();
    start(w.registry, 'child-1');
    failThrice();
    w.watcher.tick();
    expect(w.groupSignals().map((signal) => signal.rule)).toContain('R24');
    expect(w.store.getAllChatWatchSignals()).toEqual({});
    w.watcher.stop();
  });
});

describe('wireGroupWatch R22 через живость группы панели', () => {
  it('группа started без прогона 25 мин — R22 на записи группы', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire();
    vi.setSystemTime(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.groupSignals()).toMatchObject([
      { rule: 'R22', severity: 'warn', numbers: { idleMin: 25 }, params: { why: 'no-run' } },
    ]);
    w.watcher.stop();
  });

  it('прогон звена идёт (реестр) — R22 молчит', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire();
    start(w.registry, 'child-1');
    vi.setSystemTime(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.groupSignals().some((signal) => signal.rule === 'R22')).toBe(false);
    w.watcher.stop();
  });

  it('группа ждёт решения D-n — ожидание законное, R22 молчит; решили — снова R22', () => {
    // Решение 6 владельца: конец хода с одними D-n — ожидание человека списком.
    vi.useFakeTimers({ now: T0 });
    let waiting = true;
    const asked: Array<[string, number]> = [];
    const w = wire({
      extra: {
        deferredWaiting: (parentChatId, groupIndex) => {
          asked.push([parentChatId, groupIndex]);
          return waiting;
        },
      },
    });
    vi.setSystemTime(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.groupSignals()).toEqual([]);
    expect(asked).toContainEqual(['parent', 1]);
    waiting = false;
    vi.setSystemTime(T0 + 50 * MIN);
    w.watcher.tick();
    expect(w.groupSignals().map((signal) => signal.rule)).toContain('R22');
    w.watcher.stop();
  });

  it('дерево на паузе («Остановить всё») — группа стоит законно', () => {
    vi.useFakeTimers({ now: T0 });
    const w = wire({ extra: { treePaused: (chatId) => chatId === 'parent' } });
    vi.setSystemTime(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.groupSignals()).toEqual([]);
    w.watcher.stop();
  });
});
