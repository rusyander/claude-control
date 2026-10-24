import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_WATCH_DEFAULTS, groupSignalsOf } from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { qwenProjectSlug } from '../../domains/chat/token-ledger/foreign/foreign-transcript.ts';
import { wireGroupWatch } from './group-watch-wiring.ts';

/**
 * Проводка сторожа для группы Qwen Code: на первом ходе id сессии CLI ещё не
 * известен — сторож ищет свежую переписку в доме Qwen Code набора панели по
 * копии группы и началу хода. Дом, переписка и хранилище — настоящие файлы во
 * временном каталоге.
 */

const T0 = Date.parse('2026-10-20T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class IdleRun implements RunLike {
  pid = 1;
  start(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

const row = (ms: number): string =>
  `${JSON.stringify({ type: 'user', provenance: 'real_user', timestamp: at(ms), message: { role: 'user', parts: [{ text: 'go' }] } })}\n`;

function wire() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-foreign-'));
  dirs.push(dir);
  const copy = join(dir, 'copy-1');
  mkdirSync(copy);
  const chats = join(dir, 'kit', 'qwen-home', 'projects', qwenProjectSlug(copy), 'chats');
  mkdirSync(chats, { recursive: true });
  const store = new AppStore(dir);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: dir,
    createdAt: at(0),
    groups: [{ index: 1, title: 'g', status: 'started', path: copy }],
  } as unknown as SplitPlanRecord);
  const watcher = wireGroupWatch(new ChatRunRegistry(() => new IdleRun()), {
    settings: () => GROUP_WATCH_DEFAULTS,
    link: (chatId) =>
      chatId === 'qwen:child'
        ? { parentChatId: 'parent', groupIndex: 1, stage: 'work', createdAt: at(0) }
        : undefined,
    plan: (parent) => store.getSplitPlan(parent),
    plans: () => store.getSplitPlans(),
    signals: {
      get: (parent, index) => store.getGroupWatchSignals(parent, index),
      set: (parent, index, block) => store.putGroupWatchSignals(parent, index, block),
      all: () => store.getAllGroupWatchSignals(),
      save: () => store.saveGroupWatchSignals(),
    },
    asksOf: () => [],
    projectsDir: () => join(dir, 'projects'),
    heavyQueueDir: dir,
    appDataDir: dir,
  });
  const rules = () =>
    groupSignalsOf(store.getGroupWatchSignals('parent', 1)).map((signal) => signal.rule);
  return { watcher, copy, chats, rules };
}

describe('wireGroupWatch (foreign CLI)', () => {
  it('first turn: the placeholder finds the fresh session of the copy, a miss is not remembered', () => {
    vi.useFakeTimers({ now: T0 });
    const { watcher, copy, chats, rules } = wire();
    // Сессия прошлого хода в той же копии — начата до старта: не она.
    writeFileSync(join(chats, 'old.jsonl'), row(-60 * 60_000));
    watcher.onFeed('qwen:child', {
      kind: 'start',
      sessionId: 'qwen:child',
      cwd: copy,
      detached: true,
      provider: 'qwen',
    });
    // Свежей переписки ещё нет — видеть нечего, и тишина до этой минуты не улика
    // (возьми сторож старую сессию, тишина считалась бы от старта хода).
    vi.setSystemTime(T0 + 60_000);
    watcher.tick();
    // CLI записал первую строку через 10 секунд — промах не запомнен (запомненный
    // держится минуту), тик её находит, и тишина больше не сдвигается.
    writeFileSync(join(chats, 'fresh.jsonl'), row(1000));
    vi.setSystemTime(T0 + 70_000);
    watcher.tick();
    vi.setSystemTime(T0 + 20 * 60_000 + 5_000);
    watcher.tick();
    expect(rules()).toEqual([]);
    // Двадцать минут от последнего промаха — зависание; при запомненном промахе
    // тишина считалась бы от 70-й секунды и ещё не дотянула бы.
    vi.setSystemTime(T0 + 20 * 60_000 + 65_000);
    watcher.tick();
    expect(rules()).toEqual(['R1']);
    watcher.stop();
  });
});
