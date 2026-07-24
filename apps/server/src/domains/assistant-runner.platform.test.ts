import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { runAssistant, type RunAssistantDeps } from './assistant-runner.ts';

/**
 * Ф10 — one-shot запуск CLI на трёх ОС + устойчивость обёртки spawn.
 *
 * Реального spawn нет: подменяем его и `process.platform`. Проверяем три вещи,
 * которые вживую на macOS/Linux с Windows-машины не воспроизвести:
 *   • на Windows команда идёт через `cmd.exe /d /s /c` (обёртка `.cmd`), а на
 *     POSIX — напрямую, без оболочки;
 *   • запускается ИМЕННО то имя, которое детект нашёл в PATH (`codex` вместо
 *     `codex.cmd`, если стоит нативный .exe);
 *   • русский ответ не бьётся на границе чтения (декодируем один раз в конце),
 *     а закрытый раньше времени stdin не роняет сервер необработанным EPIPE.
 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: () => void;
    end: () => void;
    on: (event: string, cb: (e: Error) => void) => void;
  };
  kill: () => void;
  pid?: number;
}

function fakeSpawn(opts: { chunks?: Buffer[]; code?: number; stdinThrows?: boolean }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    let stdinError: ((e: Error) => void) | undefined;
    child.stdin = {
      on: (event, cb) => {
        if (event === 'error') stdinError = cb;
      },
      write: () => {
        // Имитируем EPIPE: CLI закрылся раньше, чем мы дописали промпт.
        if (opts.stdinThrows) stdinError?.(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
      },
      end: () => {},
    };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      for (const chunk of opts.chunks ?? []) child.stdout.emit('data', chunk);
      child.emit('close', opts.code ?? 0);
    }, 0);
    return child;
  }) as unknown as RunAssistantDeps['spawnImpl'];
  return { fn, calls };
}

function withPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-run-plat-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('spawn one-shot по платформам', () => {
  it('Windows: команда исполняется через cmd.exe /d /s /c, промпт — отдельным argv', async () => {
    withPlatform('win32');
    const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

    const res = await runAssistant(getProvider('codex'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: (command) => command === 'codex.cmd',
      spawnImpl: spawn.fn,
    });

    expect(res.ok).toBe(true);
    expect(spawn.calls[0]!.cmd.toLowerCase()).toContain('cmd');
    expect(spawn.calls[0]!.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spawn.calls[0]!.args).toContain('codex.cmd');
    expect(spawn.calls[0]!.args).toContain('привет');
  });

  it('Windows: стоит только нативный codex.exe → запускаем «голое» имя, а не .cmd', async () => {
    withPlatform('win32');
    const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

    await runAssistant(getProvider('codex'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      // `where codex.cmd` не находит, `where codex` — находит (PATHEXT → .exe).
      detect: (command) => command === 'codex',
      spawnImpl: spawn.fn,
    });

    expect(spawn.calls[0]!.args).toContain('codex');
    expect(spawn.calls[0]!.args).not.toContain('codex.cmd');
  });

  it('macOS/Linux: CLI зовётся напрямую, без cmd.exe и без оболочки', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      withPlatform(platform);
      const spawn = fakeSpawn({ chunks: [Buffer.from('ok')] });

      const res = await runAssistant(getProvider('gemini'), [{ role: 'user', content: 'привет' }], {
        appDataDir: dir,
        detect: (command) => command === 'gemini',
        spawnImpl: spawn.fn,
      });

      expect(res.ok).toBe(true);
      expect(spawn.calls[0]!.cmd).toBe('gemini');
      expect(spawn.calls[0]!.args).toEqual(['-p', 'привет']);
      vi.unstubAllGlobals();
    }
  });
});

describe('устойчивость обёртки spawn', () => {
  it('русский ответ, разрезанный по границе UTF-8, склеивается без «крокозябр»', async () => {
    withPlatform('linux');
    // Рвём буфер посередине многобайтового символа — так и делает реальный поток.
    const full = Buffer.from('Привет, это ответ модели', 'utf8');
    const cut = 5;
    const spawn = fakeSpawn({ chunks: [full.subarray(0, cut), full.subarray(cut)] });

    const res = await runAssistant(getProvider('gemini'), [{ role: 'user', content: 'п' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });

    expect(res.reply).toBe('Привет, это ответ модели');
  });

  it('EPIPE на stdin (CLI закрылся первым) не роняет процесс — отвечаем ошибкой', async () => {
    withPlatform('linux');
    const spawn = fakeSpawn({ chunks: [], code: 1, stdinThrows: true });

    const res = await runAssistant(getProvider('claude'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn.fn,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cli_error');
  });

  it('таймаут снимает процесс и возвращает внятную ошибку (без зависания)', async () => {
    withPlatform('linux');
    const spawn = ((): RunAssistantDeps['spawnImpl'] => {
      return ((): unknown => {
        const child = new EventEmitter() as FakeChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 777;
        child.stdin = { on: () => {}, write: () => {}, end: () => {} };
        child.kill = () => child.emit('close', null);
        return child;
      }) as unknown as RunAssistantDeps['spawnImpl'];
    })();

    const res = await runAssistant(getProvider('gemini'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: () => true,
      spawnImpl: spawn,
      timeoutMs: 20,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cli_error');
    expect(res.error).toMatch(/врем/i);
  });
});
