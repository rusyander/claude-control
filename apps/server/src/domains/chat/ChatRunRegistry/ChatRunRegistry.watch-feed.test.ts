import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { RunWatchFeed } from './ChatRunRegistry.types.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { RunLedgerEntry } from '../run-ledger/run-ledger.ts';

/**
 * Сторож групп видит начало и конец каждого хода: и прогона, подхваченного после
 * перезапуска панели без потока (`detached` — читается из транскрипта), и
 * остановленного «Стопом». Без `finish` сессия звена висела бы «в ходе», и R1
 * молчал бы до конца группы. Подменён только процесс.
 */

class FakeRun implements RunLike {
  pid = 4242;
  private resolve?: () => void;
  start(_options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.resolve?.();
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

function watched(registry: ChatRunRegistry): Array<{ chatId: string; feed: RunWatchFeed }> {
  const feeds: Array<{ chatId: string; feed: RunWatchFeed }> = [];
  registry.setWatchListener((chatId, feed) => feeds.push({ chatId, feed }));
  return feeds;
}

describe('ChatRunRegistry → сторож групп', () => {
  it('прогон без потока: начало с пометкой detached, конец — когда процесс умер', async () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    const feeds = watched(registry);
    const alive = { value: true };
    const entry: RunLedgerEntry = {
      key: 'child-1',
      sessionId: 's1',
      cwd: '/work/copy',
      projectPath: '/work/copy',
      pid: 424242,
      startedAt: Date.now() - 1_000,
    };
    expect(
      registry.adopt(entry, { isAlive: () => alive.value, kill: () => undefined, pollMs: 5 }),
    ).toBe(true);
    expect(feeds[0]).toEqual({
      chatId: 'child-1',
      feed: { kind: 'start', cwd: '/work/copy', detached: true, sessionId: 's1' },
    });
    alive.value = false;
    await settle();
    expect(feeds.map((entry) => entry.feed.kind)).toEqual(['start', 'finish']);
  });

  it('«Стоп» идущего прогона кормит сторожу конец хода', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    const feeds = watched(registry);
    registry.start('child-2', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    registry.stop('child-2');
    expect(feeds.map((entry) => entry.feed.kind)).toEqual(['start', 'finish']);
  });
});
