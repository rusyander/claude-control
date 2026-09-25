import { describe, it, expect, vi } from 'vitest';
import type { RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import type { RunLedgerEntry } from './run-ledger.ts';

// Граница — труба к посреднику: подхват «удался», процесс за ним отдаёт поток.
vi.mock('./run-reattach.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-reattach.ts')>()),
  reattachSession: () => ({ pipe: 'stub' }),
}));

const { ChatRunRegistry } = await import('./ChatRunRegistry.ts');

class FakeRun implements RunLike {
  onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.resolve?.();
  }
  finish(): void {
    this.resolve?.();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * Итоговое ревью 25.09 (m4): подхваченный через посредника прогон кончил ход
 * ОШИБКОЙ (лимит подписки) без текста — и считался оборванным. Обрыв
 * пропускает ожидание лимита, и конвейер дважды продолжал группу прямо в лимит.
 */
describe('подхваченный прогон, кончившийся ошибкой', () => {
  const ENTRY = {
    key: 'group-chat',
    sessionId: 'sess-g',
    pid: 4242,
    startedAt: Date.now(),
    cwd: '/tmp/wt',
    prompt: 'работа группы',
  } as unknown as RunLedgerEntry;

  function adoptWith(): { run: FakeRun; finished: { interrupted?: true; ok: boolean }[] } {
    const run = new FakeRun();
    const registry = new ChatRunRegistry(() => run);
    const finished: { interrupted?: true; ok: boolean }[] = [];
    registry.setHandoffPlanner((done) => {
      finished.push({ ok: done.ok, ...(done.interrupted ? { interrupted: true } : {}) });
      return undefined;
    });
    expect(registry.adopt(ENTRY)).toBe(true);
    return { run, finished };
  }

  it('ошибка без текста — не обрыв: итог «сбой», дорога повтора открыта', async () => {
    const { run, finished } = adoptWith();
    run.onEvent?.({ kind: 'error', message: 'usage limit reached' } as ChatEvent);
    run.finish();
    await flush();

    expect(finished).toEqual([{ ok: false }]);
  });

  it('без ошибки и без текста — по-прежнему обрыв', async () => {
    const { run, finished } = adoptWith();
    run.finish();
    await flush();

    expect(finished).toEqual([{ ok: true, interrupted: true }]);
  });
});
