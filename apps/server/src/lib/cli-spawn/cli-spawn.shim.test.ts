import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import { spawnCliProcess } from './cli-spawn.ts';

/**
 * `.cmd`-обёртка npm без `.exe` рядом — так на Windows стоит, например, qwen.
 *
 * Почему тест запускает НАСТОЯЩИЙ процесс: вопрос ровно в том, что доходит до
 * argv ребёнка. Шпион на `spawnImpl` показал бы, что МЫ передали, а не что
 * получил CLI, — а через cmd.exe это разные вещи: он обрезает строку на
 * переводе строки и подставляет `%ИМЯ%`. Поэтому ребёнок сам печатает свой
 * argv, и сравнивается он байт в байт.
 */

const onWindows = process.platform === 'win32';

/** Промпт, который cmd.exe испортил бы любым из своих способов. */
const NASTY =
  'первая строка\nвторая & whoami | more > out.txt ^caret %PATH% !x!\r\n' +
  'третья "в кавычках" 50% хвост\\';

/** Ребёнок, печатающий собственный argv. */
const ECHO_JS = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n';

/** Современный cmd-shim npm (см. `%APPDATA%\npm\*.cmd`), CRLF как в оригинале. */
function npmShim(target: string, flags = ''): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${flags} "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');
}

/** Обёртка pnpm (@zkochan/cmd-shim): NODE_PATH и старая форма `%~dp0`. */
function pnpmShim(target: string, nodePath: string): string {
  return [
    '@SETLOCAL',
    '@IF NOT DEFINED NODE_PATH (',
    `  @SET "NODE_PATH=${nodePath}"`,
    ') ELSE (',
    `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
    ')',
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
    '',
  ].join('\r\n');
}

/** Обёртка yarn из его установщика: две строки, LF. */
function yarnShim(target: string): string {
  return `@echo off\nnode "%~dp0\\${target}" %*\n`;
}

interface Run {
  error?: string;
  argv?: string[];
  stdout?: string;
}

function run(command: string, args: string[], env?: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const spawned = spawnCliProcess(command, args, env ? { env } : {});
    if (spawned.error) {
      resolve({ error: spawned.error.message });
      return;
    }
    let out = '';
    spawned.child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    spawned.child.on('error', (error) => resolve({ error: error.message }));
    spawned.child.on('close', () => {
      try {
        resolve({ argv: JSON.parse(out) as string[], stdout: out });
      } catch {
        resolve({ stdout: out });
      }
    });
  });
}

describe.skipIf(!onWindows)('lib/cli-spawn: .cmd-обёртка npm без .exe', () => {
  let dir: string;
  let bin: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-shim-'));
    bin = join(dir, 'bin');
    mkdirSync(join(bin, 'node_modules', 'fake-cli', 'dist'), { recursive: true });
    writeFileSync(join(bin, 'node_modules', 'fake-cli', 'dist', 'cli.js'), ECHO_JS);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('многострочный промпт с метасимволами доходит байт в байт', async () => {
    writeFileSync(join(bin, 'fakecli.cmd'), npmShim('node_modules\\fake-cli\\dist\\cli.js'));
    const args = ['-p', NASTY, '--flag', ''];
    const result = await run('fakecli', args);
    expect(result.error).toBeUndefined();
    expect(result.argv).toEqual(args);
  });

  it('`%ИМЯ%` в однострочном промпте больше не подставляется', async () => {
    writeFileSync(join(bin, 'fakecli.cmd'), npmShim('node_modules\\fake-cli\\dist\\cli.js'));
    const result = await run('fakecli', ['%PATH%', 'a&b', '!x!']);
    expect(result.argv).toEqual(['%PATH%', 'a&b', '!x!']);
  });

  it('флаги node из шебанга идут перед скриптом, а не в argv CLI', async () => {
    writeFileSync(
      join(bin, 'fakecli.cmd'),
      npmShim('node_modules\\fake-cli\\dist\\cli.js', '--no-warnings'),
    );
    const result = await run('fakecli', ['-p', NASTY]);
    expect(result.argv).toEqual(['-p', NASTY]);
  });

  it('имя с `.cmd` и явный путь к обёртке разбираются так же', async () => {
    writeFileSync(join(bin, 'fakecli.cmd'), npmShim('node_modules\\fake-cli\\dist\\cli.js'));
    expect((await run('fakecli.cmd', ['-p', NASTY])).argv).toEqual(['-p', NASTY]);
    expect((await run(join(bin, 'fakecli.cmd'), ['-p', NASTY])).argv).toEqual(['-p', NASTY]);
  });

  it('обёртка pnpm: путь через `..`, NODE_PATH доходит до процесса', async () => {
    const pkg = join(dir, 'store', 'fake-cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'cli.js'),
      'process.stdout.write(JSON.stringify([...process.argv.slice(2), process.env.NODE_PATH]));\n',
    );
    writeFileSync(join(bin, 'fakecli.CMD'), pnpmShim('..\\store\\fake-cli\\cli.js', 'C:\\np'));
    const result = await run('fakecli', ['-p', NASTY], { NODE_PATH: 'C:\\old' });
    expect(result.argv).toEqual(['-p', NASTY, 'C:\\np;C:\\old']);
    const fresh = await run('fakecli', ['-p', NASTY]);
    // Своего NODE_PATH у сервера может и не быть — тогда ровно значение обёртки.
    const inherited = process.env.NODE_PATH;
    expect(fresh.argv).toEqual(['-p', NASTY, inherited ? `C:\\np;${inherited}` : 'C:\\np']);
  });

  it('обёртка yarn: `node "%~dp0\\yarn.js" %*`', async () => {
    writeFileSync(join(bin, 'yarnish.js'), ECHO_JS);
    writeFileSync(join(bin, 'fakecli.cmd'), yarnShim('yarnish.js'));
    expect((await run('fakecli', ['-p', NASTY])).argv).toEqual(['-p', NASTY]);
  });

  it('обёртка npm над нативным бинарём запускает бинарь напрямую', async () => {
    // Так npm ставит claude: `"%dp0%\…\claude.exe" %*`. Бинарь здесь — сам node,
    // скопированный под чужим именем не нужен: путь указывает прямо на него.
    const spawnImpl = vi.fn(() => ({ on: vi.fn() })) as unknown as typeof nodeSpawn;
    writeFileSync(
      join(bin, 'fakecli.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node_modules\\fake-cli\\dist\\cli.exe"   %*',
        '',
      ].join('\r\n'),
    );
    writeFileSync(join(bin, 'node_modules', 'fake-cli', 'dist', 'cli.exe'), 'x');
    spawnCliProcess('fakecli', ['-p', NASTY], { spawnImpl });
    expect(spawnImpl).toHaveBeenCalledWith(
      join(bin, 'node_modules', 'fake-cli', 'dist', 'cli.exe'),
      ['-p', NASTY],
      { windowsHide: true },
    );
  });

  describe('неузнанная обёртка — поведение прежнее', () => {
    it('многострочный промпт — тот же отказ с объяснением', async () => {
      writeFileSync(join(bin, 'fakecli.cmd'), '@echo off\r\necho %*\r\n');
      const result = await run('fakecli', ['-p', NASTY]);
      expect(result.error).toMatch(/обрезает команду на первом переводе строки/);
    });

    it('однострочный — через cmd.exe тем же вызовом, что и раньше', () => {
      writeFileSync(join(bin, 'fakecli.cmd'), '@echo off\r\necho %*\r\n');
      const spawnImpl = vi.fn(() => ({ on: vi.fn() })) as unknown as typeof nodeSpawn;
      spawnCliProcess('fakecli', ['-p', 'a&b'], { spawnImpl });
      expect(spawnImpl).toHaveBeenCalledWith(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/v:off', '/c', '"fakecli -p "a&b""'],
        { windowsHide: true, windowsVerbatimArguments: true },
      );
    });

    it('цель обёртки не существует — тоже прежний путь', async () => {
      writeFileSync(join(bin, 'fakecli.cmd'), npmShim('node_modules\\нет\\cli.js'));
      const result = await run('fakecli', ['-p', NASTY]);
      expect(result.error).toMatch(/обрезает команду/);
    });

    it('обёртка не над node (шебанг sh) — прежний путь', async () => {
      writeFileSync(
        join(bin, 'fakecli.cmd'),
        npmShim('node_modules\\fake-cli\\dist\\cli.js').replace(/node\.exe|"_prog=node"/g, (m) =>
          m === 'node.exe' ? 'sh.exe' : '"_prog=sh"',
        ),
      );
      const result = await run('fakecli', ['-p', NASTY]);
      expect(result.error).toMatch(/обрезает команду/);
    });
  });
});

/**
 * POSIX-ветка не тронута — владелец не может проверить Linux/macOS вживую,
 * поэтому её вызов spawn зафиксирован буквально: ровно `command`, ровно `args`,
 * ровно прежний объект опций, даже если рядом на PATH лежит `.cmd`-обёртка.
 */
describe('lib/cli-spawn: POSIX-ветка без изменений', () => {
  let saved: PropertyDescriptor | undefined;
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(process, 'platform');
    dir = mkdtempSync(join(tmpdir(), 'cc-shim-posix-'));
    mkdirSync(join(dir, 'node_modules', 'q'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'q', 'cli.js'), ECHO_JS);
    writeFileSync(join(dir, 'qwen.cmd'), npmShim('node_modules\\q\\cli.js'));
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    if (saved) Object.defineProperty(process, 'platform', saved);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: spawn(command, args, прежние опции) — без разбора обёрток`, () => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const spawnImpl = vi.fn(() => ({ on: vi.fn() })) as unknown as typeof nodeSpawn;
      const args = ['-p', NASTY];

      spawnCliProcess('qwen', args, { spawnImpl });
      spawnCliProcess('qwen', args, { spawnImpl, cwd: '/w', env: { A: '1' } });
      spawnCliProcess('qwen', args, { spawnImpl, env: { A: '1' }, inheritEnv: false });

      const calls = (spawnImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls).toEqual([
        ['qwen', args, { windowsHide: true }],
        ['qwen', args, { windowsHide: true, cwd: '/w', env: { ...process.env, A: '1' } }],
        ['qwen', args, { windowsHide: true, env: { A: '1' } }],
      ]);
      expect(calls[0]?.[1]).toBe(args);
    });
  }
});
