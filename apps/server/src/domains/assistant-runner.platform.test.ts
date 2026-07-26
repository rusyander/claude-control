import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const calls: { cmd: string; args: string[]; options?: Record<string, unknown> }[] = [];
  const fn = ((cmd: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
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

/**
 * PATH подменяем ВСЕГДА: запуск через cmd.exe остаётся только для `.cmd`-обёртки
 * без нативного бинаря рядом, и на живом PATH разработчика (где лежит
 * `claude.exe`) проверка cmd-ветки зависела бы от того, что установлено.
 */
function withPlatform(platform: NodeJS.Platform, path: string = ''): void {
  vi.stubGlobal('process', {
    ...process,
    platform,
    env: { ...process.env, PATH: path, Path: path },
  });
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
  it('Windows: команда исполняется через cmd.exe /d /s /c одной строкой', async () => {
    withPlatform('win32');
    const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

    const res = await runAssistant(getProvider('codex'), [{ role: 'user', content: 'привет' }], {
      appDataDir: dir,
      detect: (command) => command === 'codex.cmd',
      spawnImpl: spawn.fn,
    });

    expect(res.ok).toBe(true);
    expect(spawn.calls[0]!.cmd.toLowerCase()).toContain('cmd');
    expect(spawn.calls[0]!.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(spawn.calls[0]!.args[4]).toContain('codex.cmd');
    expect(spawn.calls[0]!.args[4]).toContain('привет');
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

    expect(spawn.calls[0]!.args[4]).toContain('codex');
    expect(spawn.calls[0]!.args[4]).not.toContain('codex.cmd');
  });

  /**
   * Регрессия: промпт уходил в cmd.exe отдельным элементом argv, а libuv берёт
   * в кавычки только аргументы с пробелом, табом или кавычкой. Промпт без
   * пробелов, зато с метасимволом (`2+2>4?`, `a&whoami`) доходил до оболочки
   * голым, и она разбирала его как продолжение команды: перенаправление в файл
   * в лучшем случае, вторая команда правами сервера — в худшем.
   */
  describe('Windows: метасимволы промпта не доходят до cmd.exe голыми', () => {
    for (const prompt of ['2+2>4?', 'a&whoami', 'x|del', 'a^b', 'a<b']) {
      it(`промпт ${prompt} остаётся значением, а не командой`, async () => {
        withPlatform('win32');
        const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

        await runAssistant(getProvider('codex'), [{ role: 'user', content: prompt }], {
          appDataDir: dir,
          detect: (command) => command === 'codex.cmd',
          spawnImpl: spawn.fn,
        });

        const line = spawn.calls[0]!.args[4]!;
        // Промпт целиком внутри кавычек: cmd.exe не увидит в нём синтаксиса.
        expect(line).toContain(`"${prompt}"`);
        // И ни одного метасимвола за пределами кавычек не осталось. Внешнюю
        // пару снимаем сами — её точно так же снимет `/s` перед разбором.
        const inner = line.slice(1, -1);
        expect(inner.replace(/"[^"]*"/g, '')).not.toMatch(/[&|<>^]/);
      });
    }

    it('строку собираем сами — libuv не должен квотить по второму разу', async () => {
      withPlatform('win32');
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      await runAssistant(getProvider('codex'), [{ role: 'user', content: 'a&whoami' }], {
        appDataDir: dir,
        detect: (command) => command === 'codex.cmd',
        spawnImpl: spawn.fn,
      });

      // Внешняя пара кавычек + verbatim: ровно та форма, которую снимает /s.
      expect(spawn.calls[0]!.args[4]!.startsWith('"')).toBe(true);
      expect(spawn.calls[0]!.args[4]!.endsWith('"')).toBe(true);
      expect(spawn.calls[0]!.options?.windowsVerbatimArguments).toBe(true);
    });

    it('claude не задет: его промпт идёт через stdin, а не через оболочку', async () => {
      withPlatform('win32');
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      await runAssistant(getProvider('claude'), [{ role: 'user', content: 'a&whoami' }], {
        appDataDir: dir,
        detect: (command) => command === 'claude.cmd',
        spawnImpl: spawn.fn,
      });

      expect(spawn.calls[0]!.args[4]).not.toContain('whoami');
    });
  });

  /**
   * cmd.exe остаётся плохим посредником даже с идеальными кавычками: `%ИМЯ%` он
   * подставляет из окружения, а на первом переводе строки ОБРЕЗАЕТ команду и
   * молча (код 0) выполняет только первую строку. Промпт склеивается из истории
   * через «\n\n» — то есть обрезание ловил почти каждый второй вопрос подряд.
   * Поэтому настоящий .exe запускаем напрямую, а обрубок промпта не отправляем
   * вовсе: внятная ошибка честнее ответа на половину вопроса.
   */
  describe('Windows: cmd.exe только там, где без него нельзя', () => {
    it('нативный .exe на PATH запускается напрямую — cmd.exe в цепочке нет', async () => {
      writeFileSync(join(dir, 'codex.exe'), 'фиктивный бинарь');
      withPlatform('win32', dir);
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      await runAssistant(getProvider('codex'), [{ role: 'user', content: 'a&whoami' }], {
        appDataDir: dir,
        detect: (command) => command === 'codex.cmd',
        spawnImpl: spawn.fn,
      });

      expect(spawn.calls[0]!.cmd).toBe(join(dir, 'codex.exe'));
      // argv уходит как есть: ни кавычек, ни склейки в строку.
      expect(spawn.calls[0]!.args.at(-1)).toBe('a&whoami');
      expect(spawn.calls[0]!.options?.windowsVerbatimArguments).toBeUndefined();
    });

    it('многострочный промпт через .exe доходит целиком', async () => {
      writeFileSync(join(dir, 'codex.exe'), 'фиктивный бинарь');
      withPlatform('win32', dir);
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      await runAssistant(
        getProvider('codex'),
        [
          { role: 'user', content: 'первый вопрос' },
          { role: 'assistant', content: 'ответ' },
          { role: 'user', content: 'второй вопрос' },
        ],
        { appDataDir: dir, detect: (command) => command === 'codex.cmd', spawnImpl: spawn.fn },
      );

      expect(spawn.calls[0]!.args.at(-1)).toContain('второй вопрос');
    });

    it('только .cmd-обёртка и многострочный промпт → отказ, а не обрубок', async () => {
      withPlatform('win32');
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      const res = await runAssistant(
        getProvider('codex'),
        [
          { role: 'user', content: 'первый вопрос' },
          { role: 'assistant', content: 'ответ' },
          { role: 'user', content: 'второй вопрос' },
        ],
        { appDataDir: dir, detect: (command) => command === 'codex.cmd', spawnImpl: spawn.fn },
      );

      expect(res.ok).toBe(false);
      // Ни одного запуска: обрубленный промпт до CLI не ушёл.
      expect(spawn.calls).toHaveLength(0);
      expect(res.error).toMatch(/обрез/i);
    });

    it('кавычка в промпте не размыкает строку (инъекция через `a" & echo`)', async () => {
      withPlatform('win32');
      const spawn = fakeSpawn({ chunks: [Buffer.from('готово')] });

      await runAssistant(
        getProvider('codex'),
        [{ role: 'user', content: 'a" & echo INJECTED & "b' }],
        { appDataDir: dir, detect: (command) => command === 'codex.cmd', spawnImpl: spawn.fn },
      );

      const line = spawn.calls[0]!.args[4]!;
      // Кавычка удвоена: cmd.exe читает `""` как символ, а не как конец строки.
      expect(line).toContain('""');
      expect(line).not.toContain('\\"');
    });
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
