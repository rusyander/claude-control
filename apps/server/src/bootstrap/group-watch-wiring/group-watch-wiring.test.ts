import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { wireGroupWatch } from './group-watch-wiring.ts';

/**
 * Проводка сторожа: что панель знает о звене, доходит до правил. Путь настоящий —
 * реестр прогонов, сторож, правила; подменены только процесс CLI и хранилище.
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

function wire(asks: ChatTreeAsk[]) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wiring-'));
  dirs.push(dir);
  const record = {
    parentChatId: 'parent',
    projectPath: '/work/app',
    groups: [{ index: 1, title: 'g', status: 'started', path: '/work/app/.copies/g1' }],
  } as unknown as SplitPlanRecord;
  const registry = new ChatRunRegistry(() => new FakeRun());
  const watcher = wireGroupWatch(registry, {
    settings: () => GROUP_WATCH_DEFAULTS,
    link: (chatId) =>
      chatId === 'child-1'
        ? { parentChatId: 'parent', groupIndex: 1, stage: 'work', createdAt: '2026-10-20' }
        : undefined,
    plan: (parent) => (parent === 'parent' ? record : undefined),
    plans: () => ({ parent: record }),
    save: () => undefined,
    asksOf: () => asks,
    projectsDir: () => dir,
    heavyQueueDir: dir,
  });
  return { registry, watcher, record };
}

describe('wireGroupWatch', () => {
  it('a pending permission request is a wait for the human, not a stall; a broken ask time does not throw', () => {
    vi.useFakeTimers({ now: T0 });
    const permission: ChatTreeAsk = {
      kind: 'permission',
      runId: 'child-1',
      toolName: 'Bash',
      askedAt: 'not-a-date',
    };
    const { registry, watcher, record } = wire([permission]);
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(record.groups[0]?.watch?.signals ?? []).toEqual([]);
    watcher.stop();
  });

  it('without an ask the same silence is a stall (R1)', () => {
    vi.useFakeTimers({ now: T0 });
    const { registry, watcher, record } = wire([]);
    registry.start(
      'child-1',
      { prompt: 'задача', cwd: '/work/app/.copies/g1' },
      { origin: 'chat' },
    );
    vi.setSystemTime(T0 + 25 * 60_000);
    watcher.tick();
    expect(record.groups[0]?.watch?.signals.map((signal) => signal.rule)).toEqual(['R1']);
    watcher.stop();
  });
});
