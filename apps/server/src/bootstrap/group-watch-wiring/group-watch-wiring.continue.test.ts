import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import { wireGroupWatch } from './group-watch-wiring.ts';

/**
 * Проводка сторожа для группы Continue (`cn`): каждый ответ — свой запуск `cn -p` и
 * свой документ сессии, id сессии панели не сообщается. Сторож находит документ хода
 * в каталоге сессий по папке копии (`workspaceDirectory`) и началу хода. Каталог,
 * документы и хранилище — настоящие файлы во временном каталоге.
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

/** Документ `cn`: один ответ модели и `n` отбитых вызовов оболочки. */
function session(id: string, workspace: string, n: number): string {
  return JSON.stringify({
    sessionId: id,
    workspaceDirectory: workspace,
    history: [
      { message: { role: 'user', content: 'go' } },
      {
        message: {
          role: 'assistant',
          content: '',
          usage: { prompt_tokens: 900, completion_tokens: 4 },
        },
        toolCallStates: Array.from({ length: n }, (_, i) => ({
          toolCallId: `${id}_${i}`,
          toolCall: { id: `${id}_${i}`, function: { name: 'Bash', arguments: '{}' } },
          status: 'canceled',
          parsedArgs: { command: `git push try-${i}` },
          output: [{ content: 'Permission denied by user' }],
        })),
      },
    ],
  });
}

function wire() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-continue-'));
  dirs.push(dir);
  const copy = join(dir, 'copy-1');
  mkdirSync(copy);
  const sessions = join(dir, 'cn', 'sessions');
  mkdirSync(sessions, { recursive: true });
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
      chatId === 'continue:child'
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
    continueSessionsDir: () => sessions,
  });
  const rules = () =>
    groupSignalsOf(store.getGroupWatchSignals('parent', 1)).map((signal) => signal.rule);
  return { watcher, copy, sessions, rules, now };
}

describe('wireGroupWatch (Continue)', () => {
  it('документ хода находится по папке копии; чужая копия и прошлый ход — не он', () => {
    const { watcher, copy, sessions, rules, now } = wire();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    // Прошлый ход этой копии (до старта) и свежий ход другой копии — оба с отказами.
    const old = join(sessions, 'old.json');
    writeFileSync(old, session('old', copy, 5));
    utimesSync(old, (now - 3_600_000) / 1000, (now - 3_600_000) / 1000);
    writeFileSync(join(sessions, 'other.json'), session('other', join(copy, '..', 'copy-2'), 5));
    writeFileSync(join(sessions, 'sessions.json'), '[]');
    watcher.onFeed('continue:child', {
      kind: 'start',
      sessionId: 'continue:child',
      cwd: copy,
      detached: true,
      provider: 'continue',
    });
    vi.setSystemTime(now + 60_000);
    watcher.tick();
    expect(rules()).not.toContain('R18');
    // Свой документ хода: пять отказов — стена.
    writeFileSync(join(sessions, 'mine.json'), session('mine', copy, 5));
    vi.setSystemTime(now + 120_000);
    watcher.tick();
    expect(rules()).toContain('R18');
    watcher.stop();
  });
});
