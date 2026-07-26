import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Временный mcp-config сервера прав не должен переживать сорвавшийся запуск.
 *
 * Папка cc-perm-* с mcp.json создаётся до spawn, а убиралась только в конце
 * удачного пути: любой отказ после её создания (запись в stdin в уже закрытый
 * канал, обрыв потока вывода) оставлял её в %TEMP% вместе с id прогона и
 * адресом панели. Настоящий CLI тут не поднять, поэтому spawn подменён.
 */

/** stdin, который валится синхронно, — так же ведёт себя уже закрытый канал. */
class ThrowingStdin extends EventEmitter {
  write(): boolean {
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  }

  end(): void {}
}

class FakeChild extends EventEmitter {
  readonly stdin = new ThrowingStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

let child: FakeChild;

vi.mock('node:child_process', () => ({
  spawn: () => child,
  // process-tree берёт из того же модуля — без неё падает импорт.
  spawnSync: () => ({ status: 0 }),
}));

const { ChatRun } = await import('./ChatRunner.ts');

/** Папки прав, лежащие в системном временном каталоге прямо сейчас. */
function permDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('cc-perm-'));
}

describe('ChatRun.start: уборка временного mcp-config', () => {
  let cwd: string;

  beforeEach(() => {
    child = new FakeChild();
    cwd = mkdtempSync(join(tmpdir(), 'cc-run-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('падение запуска не оставляет папку cc-perm-* в %TEMP%', async () => {
    const before = new Set(permDirs());

    await expect(
      new ChatRun().start(
        {
          prompt: 'привет',
          cwd,
          command: 'fake-cli',
          // Именно этот режим создаёт временный конфиг: без него убирать нечего.
          permissionPrompt: { runId: 'run-1', baseUrl: 'http://127.0.0.1:5178' },
          permissionMode: 'default',
        },
        () => undefined,
      ),
    ).rejects.toThrow('EPIPE');

    expect(permDirs().filter((name) => !before.has(name))).toEqual([]);
  });
});
