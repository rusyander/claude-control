import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHookProbe } from './HookRunner.ts';
import type { EventFixture } from './HookProbe.types.ts';

/**
 * Ревью 28.09 (F-177, пробел теста): хук, убитый сигналом извне (нехватка
 * памяти, `kill`), показывался как «код 0 — пропустил». `closedVerdict` проверен
 * сам по себе, а то, что `runHookProbe` отдаёт ему сигнал из `close`, не держал
 * никто: вызов с `null` вместо сигнала оставлял набор зелёным.
 *
 * Процесс хука настоящий, `close` приходит от Node. Подменён только «убийца
 * извне»: `spawn` обёрнут, чтобы тест мог послать сигнал тому же процессу, —
 * на Windows иначе сигнального выхода не бывает вовсе (чужой TerminateProcess
 * даёт код, а не сигнал). На POSIX рядом — настоящий `kill -9` самой оболочки.
 */
const spawned = vi.hoisted(() => [] as ChildProcess[]);

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const child = real.spawn(...args);
      spawned.push(child);
      return child;
    },
  };
});

const fixture: EventFixture = {
  id: 'custom',
  event: 'PreToolUse',
  title: 'проба',
  description: 'проба',
  expectsBlock: false,
  payload: { hook_event_name: 'PreToolUse' },
};

describe('runHookProbe: хук убит сигналом (F-177)', { timeout: 20_000 }, () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hook-signal-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('SIGKILL извне — error с сигналом, а не «код 0, пропустил»', async () => {
    spawned.length = 0;
    const running = runHookProbe(`node -e "setTimeout(() => {}, 1500)"`, fixture, dir);
    const child = spawned[0];
    expect(child).toBeDefined();
    child!.kill('SIGKILL');
    const result = await running;
    expect(result).toMatchObject({
      exitCode: -1,
      signal: 'SIGKILL',
      decision: 'error',
      reasonCode: 'sandbox-hook-signal',
      reasonParams: { signal: 'SIGKILL' },
      timedOut: false,
      matchesExpectation: false,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'оболочка хука убила себя kill -9 — тот же итог (POSIX)',
    async () => {
      const result = await runHookProbe('kill -9 $$', fixture, dir);
      expect(result).toMatchObject({
        exitCode: -1,
        signal: 'SIGKILL',
        decision: 'error',
        reasonCode: 'sandbox-hook-signal',
      });
    },
  );
});
