import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher } from './group-watcher.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

/**
 * Веер субагентов (R13) против расхода группы (R8): R13 прячет R8, только когда
 * расход в окне R8 — в основном субагенты. Порог R8 — 1 W/ч, чтобы три тяжёлых
 * вызова (по 6.25 W, 75 W/ч) уже «жгли».
 */
function setup(subagentDirs: Record<string, string> = {}) {
  let now = T0;
  const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS, burnPerHour: 1 };
  const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const watcher = new GroupWatcher({
    settings: () => settings,
    resolve: (chatId) =>
      chatId.startsWith('child')
        ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }
        : undefined,
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: () => {},
    node: () => ({ running: true, paused: false }),
    notify: () => {},
    now: () => now,
    plans: () => ({ parent: { groups: [group] } }),
    subagentDir: (id) => subagentDirs[id],
  });
  return {
    watcher,
    at: (t: number) => {
      now = t;
    },
    event: (chatId: string, event: ChatEvent, sessionId: string) =>
      watcher.onFeed(chatId, { kind: 'event', event, sessionId }),
    /** Активные сигналы группы: правило → звено. */
    active: () =>
      (group.watch?.signals ?? [])
        .filter((signal) => !signal.clearedAt)
        .map((signal) => `${signal.rule}@${signal.chatId}`),
  };
}

const spawn = (n: number): ChatEvent => ({
  kind: 'tool',
  id: `task${n}`,
  name: 'Task',
  input: { description: `look ${n}`, subagent_type: 'Explore' },
});

/** Вызов главной сессии: 1M записи кэша на Opus 4.8 — 6.25 W. */
const heavy = (over: Partial<Extract<ChatEvent, { kind: 'usage' }>> = {}): ChatEvent => ({
  kind: 'usage',
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 1_000_000,
  model: 'claude-opus-4-8',
  ...over,
});

/** Строка транскрипта субагента: тот же вес 6.25 W. */
const subLine = (n: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    timestamp: new Date(T0 + n * 1000).toISOString(),
    message: {
      id: `sub${n}`,
      model: 'claude-opus-4-8',
      usage: { cache_creation_input_tokens: 1_000_000 },
      content: [],
    },
  })}\n`;

function spawnSix(w: ReturnType<typeof setup>, chatId: string, sessionId: string, base = 0): void {
  for (let n = 1; n <= 6; n += 1) {
    w.at(T0 + base + n * 1000);
    w.event(chatId, spawn(n), sessionId);
  }
}

describe('GroupWatcher: subagent fan-out (R13) against group burn (R8)', () => {
  it('a fan-out by spawn count alone leaves R8 when the burn is the session itself', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    spawnSix(w, 'child-1', 's1');
    for (let n = 1; n <= 3; n += 1) {
      w.at(T0 + (10 + n) * 1000);
      w.event('child-1', heavy(), 's1');
    }
    expect(w.active()).toEqual(expect.arrayContaining(['R13@child-1', 'R8@child-1']));
  });

  it('a fan-out whose subagents carry most of the burn names the cause: R13 without R8', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-fanout-own-'));
    try {
      const w = setup({ s1: dir });
      w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
      spawnSix(w, 'child-1', 's1');
      // Своя малая доля звена — 0.625 W против 18.75 W субагентов.
      w.at(T0 + 10_000);
      w.event('child-1', heavy({ cacheCreation: 100_000 }), 's1');
      writeFileSync(join(dir, 'agent-a.jsonl'), subLine(11) + subLine(12) + subLine(13));
      w.at(T0 + MIN);
      w.watcher.tick();
      expect(w.active()).toContain('R13@child-1');
      expect(w.active().filter((key) => key.startsWith('R8'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a sibling link's active fan-out hides R8 raised by another link's subagent burn", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-fanout-sibling-'));
    try {
      const w = setup({ s2: dir });
      w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
      w.watcher.onFeed('child-2', { kind: 'start', sessionId: 's2', cwd: '/work/app' });
      spawnSix(w, 'child-1', 's1');
      expect(w.active()).toEqual(['R13@child-1']);
      // 18.75 W субагентов child-2 — ниже своего порога веера (20 W), выше порога R8.
      writeFileSync(join(dir, 'agent-a.jsonl'), subLine(11) + subLine(12) + subLine(13));
      w.at(T0 + MIN);
      // На тике child-1 судится раньше, чем child-2 прочёл хвост: R8 решает судья child-2.
      w.watcher.tick();
      expect(w.active()).toEqual(['R13@child-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the stream remainder is group burn, never subagent burn: no R13 by its weight, R8 stays', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    // 4 × 6.25 W = 25 W — выше порога веера по весу (20 W), будь это субагенты.
    for (let n = 1; n <= 4; n += 1) {
      w.at(T0 + n * 1000);
      w.event('child-1', heavy({ remainder: true }), 's1');
    }
    expect(w.active()).toEqual(['R8@child-1']);
    // Веер по числу запусков есть, но остаток — не его расход: R8 не прячется.
    spawnSix(w, 'child-1', 's1', 10_000);
    expect(w.active()).toEqual(expect.arrayContaining(['R13@child-1', 'R8@child-1']));
  });

  it('twenty skill calls do not evict six subagent spawns from the fan-out count', () => {
    const w = setup();
    w.watcher.onFeed('child-1', { kind: 'start', sessionId: 's1', cwd: '/work/app' });
    spawnSix(w, 'child-1', 's1');
    for (let n = 1; n <= 20; n += 1) {
      w.at(T0 + (10 + n) * 1000);
      w.event(
        'child-1',
        { kind: 'tool', id: `skill${n}`, name: 'Skill', input: { skill: 'review' } },
        's1',
      );
    }
    w.at(T0 + MIN);
    w.watcher.tick();
    expect(w.active()).toContain('R13@child-1');
  });
});
