import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import {
  OPENCODE_FIXTURE,
  appendOpencodeRows,
  deniedTurn,
  writeOpencodeDb,
} from '../../domains/chat/token-ledger/foreign/opencode-db.fixture.ts';
import { wireGroupWatch } from './group-watch-wiring.ts';

/**
 * Проводка сторожа для группы OpenCode: переписка — сессия в базе SQLite CLI, id
 * сессии на первом ходе панели ещё не известен. Сторож находит сессию хода по папке
 * копии (база хранит её полным путём с прямыми косыми) и началу хода. База — схема
 * НАСТОЯЩЕГО opencode 1.18.35 во временном каталоге, хранилище — настоящие файлы.
 */

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

const ROOT_ROW = OPENCODE_FIXTURE.rows.session[0];

/** Корневая сессия каталога `directory`, рождённая в `born`. */
function sessionRow(id: string, directory: string, born: number) {
  return { ...ROOT_ROW, id, parent_id: null, directory, time_created: born, time_updated: born };
}

function wire() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-opencode-'));
  dirs.push(dir);
  const copy = join(dir, 'copy-1');
  mkdirSync(copy);
  const db = join(dir, 'opencode.db');
  const store = new AppStore(dir);
  const now = Date.now();
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: dir,
    createdAt: new Date(now).toISOString(),
    groups: [{ index: 1, title: 'g', status: 'started', path: copy }],
  } as unknown as SplitPlanRecord);
  const watcher = wireGroupWatch(new ChatRunRegistry(() => new IdleRun()), {
    settings: () => GROUP_WATCH_DEFAULTS,
    link: (chatId) =>
      chatId === 'opencode:child'
        ? {
            parentChatId: 'parent',
            groupIndex: 1,
            stage: 'work',
            createdAt: new Date(now).toISOString(),
          }
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
    opencodeDb: () => db,
  });
  const rules = () =>
    groupSignalsOf(store.getGroupWatchSignals('parent', 1)).map((signal) => signal.rule);
  // Как пишет CLI: полный путь (короткое имя 8.3 временного каталога развёрнуто), косые прямые.
  const stored = realpathSync.native(copy).replace(/\\/g, '/');
  return { watcher, copy, stored, db, rules, now };
}

describe('wireGroupWatch (OpenCode)', () => {
  it('сессия хода находится по папке копии; чужая копия и прошлый ход — не она', () => {
    const { watcher, copy, stored, db, rules, now } = wire();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    // Прошлый ход этой копии (до старта) и свежий ход другой копии — оба с отказами.
    writeOpencodeDb(db, (rows) => {
      rows.session = [
        sessionRow('ses_old', stored, now - 3_600_000),
        sessionRow('ses_other', stored.replace(/copy-1$/, 'copy-2'), now + 500),
      ];
      rows.message = [];
      rows.part = [];
    });
    appendOpencodeRows(db, deniedTurn('ses_old', now - 3_000_000, 5, 'old'));
    appendOpencodeRows(db, deniedTurn('ses_other', now + 1_000, 5, 'other'));
    watcher.onFeed('opencode:child', {
      kind: 'start',
      sessionId: 'opencode:child',
      cwd: copy,
      detached: true,
      provider: 'opencode',
    });
    vi.setSystemTime(now + 60_000);
    watcher.tick();
    expect(rules()).not.toContain('R18');
    // Своя сессия хода: пять отказов — стена.
    appendOpencodeRows(db, { session: [sessionRow('ses_mine', stored, now + 61_000)] });
    appendOpencodeRows(db, deniedTurn('ses_mine', now + 62_000, 5, 'mine'));
    vi.setSystemTime(now + 120_000);
    watcher.tick();
    expect(rules()).toContain('R18');
    watcher.stop();
  });
});
