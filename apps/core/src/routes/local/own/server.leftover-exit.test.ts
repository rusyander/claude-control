import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pidAlive } from '../../../platform/kept-launch.ts';
import { stopLeftover } from './server.ts';

/**
 * Хранитель, что сам сообщил «цель вышла рано», в этот миг ещё уходит: номер без личности, поиск
 * по метке его не видит. Остановка ждёт его ухода коротко, а не объявляет остатком сразу (полный
 * прогон 30.10 под нагрузкой: «keeper pid … alive after the stop, identity unread» после трёх
 * ранних выходов). Живой дольше срока — остаток, как был. Процессы и остановка настоящие;
 * остановка обёрнута, только чтобы процесс начал уходить ПОСЛЕ неё, а не случайно до.
 */

const hooks = vi.hoisted(() => ({ afterStop: undefined as (() => void) | undefined }));

vi.mock('../../../platform/tree-stop.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/tree-stop.ts')>();
  return {
    ...real,
    stopTree: async (...args: Parameters<typeof real.stopTree>) => {
      const report = await real.stopTree(...args);
      hooks.afterStop?.();
      return report;
    },
  };
});

const MARKER = `leftover-exit-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'leftover-exit-'));

/** Процесс без метки; выходит сам, как только появится файл `go`. */
const child = (go: string) => {
  const proc = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs');
       setInterval(() => fs.existsSync(${JSON.stringify(go)}) && process.exit(0), 20);`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  if (proc.pid === undefined) throw new Error('spawn failed');
  return { proc, pid: proc.pid };
};

describe('stopLeftover of a bare keeper number', () => {
  it('a keeper still exiting on its own is waited for: no leftover, the number is gone', async () => {
    const go = join(dir, 'go-1');
    const { pid } = child(go);
    hooks.afterStop = () => writeFileSync(go, '');
    expect(await stopLeftover(pid, MARKER)).toBeUndefined();
    expect(pidAlive(pid)).toBe(false);
  }, 30_000);

  it('a number still alive past the wait stays a leftover with its reason', async () => {
    const { proc, pid } = child(join(dir, 'never'));
    hooks.afterStop = undefined;
    try {
      expect(await stopLeftover(pid, MARKER)).toBe(
        `keeper pid ${pid} alive after the stop, identity unread`,
      );
    } finally {
      proc.kill();
    }
  }, 30_000);
});
