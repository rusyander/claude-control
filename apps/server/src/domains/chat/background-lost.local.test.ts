import { describe, it, expect } from 'vitest';
import { continueOnBackgroundLost } from './background-lost.ts';
import { AutoContinue } from './auto-continue/auto-continue.ts';
import type { RunOptions } from './ChatRunner/ChatRunner.ts';
import type { RunMeta } from './ChatRunRegistry/ChatRunRegistry.ts';

/**
 * Процесс обычного чата на локальной модели ушёл, держа фонового субагента (L6):
 * пробуждения не будет — продолжение L4b заводит ход «продолжай» в ту же сессию.
 * Облачный чат и группа разделения — не сюда.
 */

function harness(local: boolean, link?: { parentChatId: string }) {
  const started: Array<{ chatId: string; options: RunOptions; meta: RunMeta }> = [];
  const scheduled: Array<() => void> = [];
  const autoContinue = new AutoContinue({
    start: (chatId, options, meta) => {
      started.push({ chatId, options, meta });
      return true;
    },
    isLocal: (finished) => finished.local === true,
    schedule: (run) => scheduled.push(run),
    log: () => undefined,
  });
  const listener = continueOnBackgroundLost(
    { getChatLink: () => link as never },
    {
      lastRunOf: (keys) =>
        keys.includes('sess-1')
          ? {
              chatId: 'new-1',
              sessionId: 'sess-1',
              options: { prompt: 'review MR', cwd: 'C:/work/x' },
              meta: { projectPath: 'C:/work/x', ...(local ? { local: true as const } : {}) },
            }
          : undefined,
    },
    autoContinue,
  );
  return { listener, started, scheduled };
}

describe('continueOnBackgroundLost', () => {
  it('локальный чат: через паузу — «продолжай» в ту же сессию, без ветвления', () => {
    const { listener, started, scheduled } = harness(true);
    listener(['sess-1']);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(started).toHaveLength(1);
    expect(started[0]?.chatId).toBe('new-1');
    expect(started[0]?.options).toMatchObject({ sessionId: 'sess-1', fork: false });
    expect(started[0]?.options.prompt).toContain('[Автоматически] Продолжай');
  });

  it('облачный чат, группа разделения или неизвестный разговор — ничего', () => {
    const cloud = harness(false);
    cloud.listener(['sess-1']);
    expect(cloud.scheduled).toHaveLength(0);
    const group = harness(true, { parentChatId: 'hub' });
    group.listener(['sess-1']);
    expect(group.scheduled).toHaveLength(0);
    const unknown = harness(true);
    unknown.listener(['other']);
    expect(unknown.scheduled).toHaveLength(0);
  });
});
