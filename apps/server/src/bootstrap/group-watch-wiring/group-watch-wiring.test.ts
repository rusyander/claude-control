import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  groupSignalsOf,
  type GroupSignal,
} from '@agentdeck/contracts/group-watch';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { wireGroupWatch, type GroupWatchWiringDeps } from './group-watch-wiring.ts';

/**
 * Проводка сторожа: что панель знает о звене, доходит до правил. Путь настоящий —
 * реестр прогонов, сторож, правила, хранилище панели во временном каталоге;
 * подменён только процесс CLI.
 */

class FakeRun implements RunLike {
  pid = 4242;
  start(_options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

const T0 = Date.parse('2026-10-20T10:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Прогон, чьи события тест подаёт сам: путь дальше — настоящий (реестр → сторож → правила). */
let emit: ((event: ChatEvent) => void) | undefined;
class EmittingRun extends FakeRun {
  override start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    emit = onEvent;
    return super.start(options, onEvent);
  }
}

function wire(asks: ChatTreeAsk[], extra: Partial<GroupWatchWiringDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-'));
  dirs.push(dir);
  const store = new AppStore(dir);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: '/work/app',
    createdAt: '2026-10-20T10:00:00.000Z',
    groups: [{ index: 1, title: 'g', status: 'started', path: '/work/app/.copies/g1' }],
  } as unknown as SplitPlanRecord);
  const registry = new ChatRunRegistry(() => new EmittingRun());
  const watcher = wireGroupWatch(registry, {
    settings: () => GROUP_WATCH_DEFAULTS,
    link: (chatId) =>
      chatId === 'child-1'
        ? { parentChatId: 'parent', groupIndex: 1, stage: 'work', createdAt: '2026-10-20' }
        : undefined,
    plan: (parent) => store.getSplitPlan(parent),
    plans: () => store.getSplitPlans(),
    signals: {
      get: (parent, index) => store.getGroupWatchSignals(parent, index),
      set: (parent, index, block) => store.putGroupWatchSignals(parent, index, block),
      all: () => store.getAllGroupWatchSignals(),
      save: () => store.saveGroupWatchSignals(),
    },
    asksOf: () => asks,
    projectsDir: () => dir,
    heavyQueueDir: dir,
    ...extra,
  });
  const signals = (): GroupSignal[] => groupSignalsOf(store.getGroupWatchSignals('parent', 1));
  return { registry, watcher, store, signals, dir };
}

const rulesOf = (signals: readonly GroupSignal[]): string[] => signals.map((signal) => signal.rule);

describe('wireGroupWatch', () => {
  it('a pending permission request is a wait for the human, not a stall; a broken ask time does not throw', () => {
    vi.useFakeTimers({ now: T0 });
    const permission: ChatTreeAsk = {
      kind: 'permission',
      runId: 'child-1',
      toolName: 'Bash',
      askedAt: 'not-a-date',
    };
    const { registry, watcher, signals } = wire([permission]);
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(signals()).toEqual([]);
    watcher.stop();
  });

  it('without an ask the same silence is a stall (R1)', () => {
    vi.useFakeTimers({ now: T0 });
    const { registry, watcher, signals } = wire([]);
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(signals().map((signal) => signal.rule)).toEqual(['R1']);
    watcher.stop();
  });

  // F-54: «Остановить всё» статус группы не меняет — пауза дерева всё равно пауза
  // группы: сессия, разбуженная на ней, — R20, а не тишина.
  for (const withTime of [true, false]) {
    it(`a tree pause marks the group node paused; acting on it is R20 (${withTime ? 'pause time from the tree' : 'pause time as first seen'})`, () => {
      vi.useFakeTimers({ now: T0 });
      let paused = false;
      const pausedAt = T0 + 5 * 60_000;
      const { registry, watcher, signals } = wire([], {
        treePaused: () => paused,
        ...(withTime ? { treePausedAt: () => (paused ? pausedAt : undefined) } : {}),
      });
      registry.start(
        'child-1',
        { prompt: 'задача', cwd: '/work/app/.copies/g1' },
        { origin: 'chat' },
      );
      vi.setSystemTime(pausedAt);
      paused = true;
      watcher.tick();
      expect(rulesOf(signals())).toEqual([]);
      vi.setSystemTime(T0 + 10 * 60_000);
      emit?.({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'git commit -m x' } });
      emit?.({ kind: 'toolResult', toolUseId: 't1', chars: 10 });
      expect(rulesOf(signals())).toEqual(['R20']);
      watcher.stop();
    });
  }

  // F-42: сигналы — свой срез хранилища. Конвейер пишет запись разделения, собранную
  // до долгого `await`; поднятый за это время сигнал остаётся и на диске, и в виде.
  it('a conveyor write of a record taken before the signal keeps the signal (own store slice)', () => {
    vi.useFakeTimers({ now: T0 });
    const { registry, watcher, store, signals, dir } = wire([]);
    const stale = structuredClone(store.getSplitPlan('parent') as SplitPlanRecord);
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(rulesOf(signals())).toEqual(['R1']);
    store.setSplitPlan(stale);
    expect(rulesOf(signals())).toEqual(['R1']);
    expect(store.getSplitPlan('parent')?.groups[0]?.watch).toBeUndefined();
    // Перезапуск панели: сигнал читается с диска из своего среза.
    const reloaded = new AppStore(dir);
    expect(rulesOf(groupSignalsOf(reloaded.getGroupWatchSignals('parent', 1)))).toEqual(['R1']);
    watcher.stop();
  });

  // F-62: вкладки узнают о сигнале рассылкой сразу после записи, а не на следующем опросе.
  it('a saved signal is broadcast for the parent right after the write', () => {
    vi.useFakeTimers({ now: T0 });
    const calls: string[] = [];
    const { registry, watcher } = wire([], {
      signals: {
        get: () => undefined,
        set: () => undefined,
        all: () => ({}),
        save: () => calls.push('save'),
      },
      changed: (parent) => calls.push(`changed:${parent}`),
    });
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(calls).toEqual(['save', 'changed:parent']);
    watcher.stop();
  });

  // F-38 (R9): прогноз окна строится по журналу лимита всех прогонов аккаунта в каталоге данных.
  it('R9 reads the account limit journal from the app data dir', () => {
    vi.useFakeTimers({ now: T0 });
    const appDataDir = mkdtempSync(join(tmpdir(), 'gw-appdata-'));
    dirs.push(appDataDir);
    const resetsAt = (T0 + 2 * 60 * 60_000) / 1000;
    const journal = [
      {
        id: 'other-run',
        chatId: 'ordinary-chat',
        startedAt: T0 - 30 * 60_000,
        endedAt: T0,
        tokens: 1,
        samples: [
          { at: T0 - 20 * 60_000, fiveHour: { utilization: 0.3, resetsAt } },
          { at: T0, fiveHour: { utilization: 0.5, resetsAt } },
        ],
      },
    ];
    writeFileSync(join(appDataDir, 'limit-runs.json'), JSON.stringify(journal));
    const { registry, watcher, signals } = wire([], { appDataDir });
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 60_000);
    watcher.tick();
    expect(rulesOf(signals())).toEqual(['R9']);
    expect(signals()[0]?.numbers).toMatchObject({ nowPct: 50 });
    watcher.stop();
  });

  // F-44: корень панели — полным путём; копия, открытая под коротким именем 8.3, всё равно совпадает.
  // Где коротких имён нет (Linux, macOS), оба написания совпадают и тест проверяет простой случай.
  it('R7 matches a read of the panel by its long path when the root is given by its short name', () => {
    vi.useFakeTimers({ now: T0 });
    const panelRoot = mkdtempSync(join(tmpdir(), 'gw-panel-'));
    dirs.push(panelRoot);
    mkdirSync(join(panelRoot, 'src'));
    writeFileSync(join(panelRoot, 'src', 'a.ts'), '');
    const longFile = join(realpathSync.native(panelRoot), 'src', 'a.ts');
    const { registry, watcher, signals } = wire([], { panelRoot });
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    emit?.({ kind: 'tool', id: 'tool-1', name: 'Read', input: { file_path: longFile } });
    vi.setSystemTime(T0 + 60_000);
    watcher.tick();
    expect(rulesOf(signals())).toContain('R7');
    watcher.stop();
  });

  // R17: билет хука очереди (живой pid, своя сессия) — ожидание места, а не зависание.
  it('a live queue ticket of the link is R17 with the masked command and the count ahead, not R1', () => {
    vi.useFakeTimers({ now: T0 });
    const { registry, watcher, signals, dir } = wire([]);
    mkdirSync(join(dir, 'tickets'));
    const ticket = (name: string, session: string, created: number, command?: string) =>
      writeFileSync(
        join(dir, 'tickets', `${name}.json`),
        JSON.stringify({ pid: process.pid, session, created, ...(command ? { command } : {}) }),
      );
    ticket('a', 'other-session', T0 - 60_000);
    ticket('b', 'child-1', T0, 'pnpm test --run');
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(rulesOf(signals())).toEqual(['R17']);
    expect(signals()[0]).toMatchObject({
      numbers: { waitMin: 25, ahead: 1 },
      params: { command: 'pnpm test --run' },
    });
    watcher.stop();
  });

  it('several tickets of one link: the wait counts from the earliest key, the secret stays masked', () => {
    vi.useFakeTimers({ now: T0 });
    const { registry, watcher, signals, dir } = wire([]);
    mkdirSync(join(dir, 'tickets'));
    const ticket = (name: string, session: string, created: number, command: string) =>
      writeFileSync(
        join(dir, 'tickets', `${name}.json`),
        JSON.stringify({ pid: process.pid, session, created, command }),
      );
    // Билет под ключом чата — позже; под id сессии (второй ключ) — раньше на 5 минут.
    ticket('chat', 'child-1', T0, 'pnpm lint');
    ticket('sess', 's-real', T0 - 5 * 60_000, 'GITLAB_TOKEN=glpat-abc123def pnpm test --run');
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    emit?.({ kind: 'session', sessionId: 's-real', model: 'claude-opus-4-8', tools: 0 });
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    const r17 = signals().find((signal) => signal.rule === 'R17');
    expect(r17).toMatchObject({
      numbers: { waitMin: 30 },
      params: { command: 'GITLAB_TOKEN=*** pnpm test --run' },
    });
    expect(JSON.stringify(signals())).not.toContain('glpat-abc123def');
    watcher.stop();
  });
});
