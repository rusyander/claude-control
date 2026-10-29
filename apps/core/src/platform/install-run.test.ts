import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { runInstall } from './install-run.ts';

/**
 * Запуск установщика копии по настоящему пути: настоящий процесс (node как крошечный офлайн
 * «установщик»), лог на диске, CI=1 и полный пин окружения, остановка дерева по сроку.
 */

const ENV = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

describe('install run', () => {
  it('exit code, mixed output and the log file are kept; CI=1 is set for the installer', async () => {
    const dir = tempDir('ir-');
    const logFile = join(dir, 'logs', 'install-1.log');
    const got = await runInstall({
      command: process.execPath,
      args: [
        '-e',
        "console.log('ci=' + process.env.CI); console.error('ERR_FETCH x'); process.exit(3)",
      ],
      cwd: dir,
      env: ENV,
      timeoutMs: 60_000,
      logFile,
    });
    expect(got).toMatchObject({ exit: 3, timedOut: false });
    expect(got.output).toContain('ci=1');
    expect(got.output).toContain('ERR_FETCH x');
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('ERR_FETCH x');
    expect(log).toContain('[core] exit 3');
  });

  it('the first line matching firstLineOf is caught in the stream, past the 64 KB the tail keeps', async () => {
    const dir = tempDir('ir-');
    const got = await runInstall({
      command: process.execPath,
      args: [
        '-e',
        // `exitCode`, не `process.exit`: на Linux вывод в канал асинхронный, и exit обрывал его на
        // ~64 КБ — хвост тогда держал и начало, проверка «за пределом хвоста» не шла.
        "console.error('npm error code ERESOLVE'); for (let i = 0; i < 4000; i++) console.log('npm error peer dep-' + i + ' ' + 'x'.repeat(40)); process.exitCode = 1",
      ],
      cwd: dir,
      env: ENV,
      timeoutMs: 60_000,
      logFile: join(dir, 'logs', 'install-1.log'),
      firstLineOf: (line) => /npm error/.test(line),
    });
    expect(got.exit).toBe(1);
    // Вывод дошёл целиком, а хвост первую строку (и строку команды с тем же словом) уже не держит.
    expect(got.output).toContain('npm error peer dep-3999 ');
    expect(got.output).not.toContain('ERESOLVE');
    expect(got.firstLine).toBe('npm error code ERESOLVE');
  });

  it('an installer past its time limit is stopped as a tree and reported as timed out', async () => {
    const dir = tempDir('ir-');
    const started = Date.now();
    const got = await runInstall({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      env: ENV,
      timeoutMs: 1_500,
      logFile: join(dir, 'install.log'),
    });
    expect(got.timedOut).toBe(true);
    expect(got.exit).toBeNull();
    expect(got.leftover).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(readFileSync(join(dir, 'install.log'), 'utf8')).toContain(
      '[core] stopped after 1500 ms',
    );
  });

  it('a missing installer binary is a named refusal or error, never exit 0', async () => {
    const dir = tempDir('ir-');
    const got = await runInstall({
      command: 'agentdeck-no-such-installer',
      args: ['install'],
      cwd: dir,
      env: ENV,
      timeoutMs: 30_000,
      logFile: join(dir, 'install.log'),
    });
    expect(got.exit).not.toBe(0);
    expect(got.refused ?? got.output).toMatch(/refused|error|not found|ENOENT/i);
  });
});
