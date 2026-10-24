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

  it('ответвление тёплой сессии называет сторожу родителя (forkOf), обычный ход — нет', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    const feeds = watched(registry);
    registry.start(
      'child-deliver',
      { prompt: 'доставка', cwd: '/work', sessionId: 's-work', fork: true },
      { origin: 'chat' },
    );
    registry.start('child-work', { prompt: 'работа', cwd: '/work' }, { origin: 'chat' });
    expect(feeds.map((entry) => entry.feed)).toEqual([
      { kind: 'start', sessionId: undefined, cwd: '/work', forkOf: 's-work' },
      { kind: 'start', sessionId: undefined, cwd: '/work' },
    ]);
  });

  it('сжатие окна идёт только сторожу: ни в буфер, ни подписчику ленты', () => {
    let emit: ((event: ChatEvent) => void) | undefined;
    class Capturing extends FakeRun {
      override start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
        emit = onEvent;
        return super.start(options, onEvent);
      }
    }
    const registry = new ChatRunRegistry(() => new Capturing());
    const feeds = watched(registry);
    registry.start('child-3', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    const seen: string[] = [];
    registry.attach('child-3', 0, {
      send: (frame: { event: ChatEvent }) => seen.push(frame.event.kind),
    } as never);
    emit?.({ kind: 'compact', trigger: 'auto' } as ChatEvent);
    emit?.({ kind: 'text', text: 'дальше' });
    const watchedKinds = feeds.flatMap((entry) =>
      entry.feed.kind === 'event' ? [entry.feed.event.kind] : [],
    );
    expect(watchedKinds).toEqual(['compact', 'text']);
    expect(seen).not.toContain('compact');
    expect(seen).toContain('text');
  });

  it('повтор запроса к модели (R30) идёт только сторожу: ни подписчику ленты, ни в буфер для поздней вкладки', () => {
    let emit: ((event: ChatEvent) => void) | undefined;
    class Capturing extends FakeRun {
      override start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
        emit = onEvent;
        return super.start(options, onEvent);
      }
    }
    const registry = new ChatRunRegistry(() => new Capturing());
    const feeds = watched(registry);
    registry.start('child-5', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    const live: string[] = [];
    registry.attach('child-5', 0, {
      send: (frame: { event: ChatEvent }) => live.push(frame.event.kind),
    } as never);
    emit?.({ kind: 'apiRetry', attempt: 1, status: 529, error: 'overloaded' });
    emit?.({ kind: 'text', text: 'дальше' });
    const watchedKinds = feeds.flatMap((entry) =>
      entry.feed.kind === 'event' ? [entry.feed.event.kind] : [],
    );
    expect(watchedKinds).toEqual(['apiRetry', 'text']);
    expect(live).toEqual(['text']);
    // Вкладка, открытая позже, получает буфер с начала — повтора в нём нет.
    const late: string[] = [];
    registry.attach('child-5', 0, {
      send: (frame: { event: ChatEvent }) => late.push(frame.event.kind),
    } as never);
    expect(late).not.toContain('apiRetry');
    expect(late).toContain('text');
  });

  it('выход сервера пишет в журнал лимита замеры идущего прогона, которые ждали пятиминутного шага', () => {
    let emit: ((event: ChatEvent) => void) | undefined;
    class Detachable extends FakeRun {
      readonly live = { pipe: 'p', pid: 1, signature: 's' };
      override start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
        emit = onEvent;
        return super.start(options, onEvent);
      }
      detach(): void {}
    }
    const registry = new ChatRunRegistry(() => new Detachable());
    const journal: Array<{ samples: readonly unknown[] }> = [];
    registry.setLimitJournal((record) => journal.push(record));
    registry.start('child-4', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    const limit = (utilization: number): ChatEvent => ({
      kind: 'limit',
      resetsAt: 2_000_000_000,
      type: 'five_hour',
      status: 'allowed',
      sample: { at: Date.now(), fiveHour: { utilization, resetsAt: 2_000_000_000 } },
    });
    emit?.(limit(0.1));
    emit?.(limit(0.4));
    // Первый замер записан сразу, второй ждёт шага.
    expect(journal.map((record) => record.samples.length)).toEqual([1]);
    registry.detachAll();
    expect(journal.at(-1)?.samples).toHaveLength(2);
  });

  it('«Стоп» идущего прогона кормит сторожу конец хода', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    const feeds = watched(registry);
    registry.start('child-2', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    registry.stop('child-2');
    expect(feeds.map((entry) => entry.feed.kind)).toEqual(['start', 'finish']);
  });
});
