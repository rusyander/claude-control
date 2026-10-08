import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveWindowsExecutable, cmdWouldTruncate } from './win-exec.ts';

/**
 * Настоящий .exe запускается без оболочки, и тогда cmd.exe не может ни
 * подставить `%ИМЯ%`, ни обрезать команду на переводе строки. Поиск обязан
 * находить бинарь даже там, где детект вернул имя `.cmd`-обёртки.
 */
describe('resolveWindowsExecutable', () => {
  let dir: string;
  let other: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-winexec-'));
    other = join(dir, 'пусто');
    mkdirSync(other, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (path: string): NodeJS.ProcessEnv => ({ PATH: path });

  it('по имени обёртки находит нативный бинарь на PATH', () => {
    writeFileSync(join(dir, 'codex.exe'), 'x');
    expect(resolveWindowsExecutable('codex.cmd', env([other, dir].join(delimiter)))).toBe(
      join(dir, 'codex.exe'),
    );
  });

  it('голое имя тоже разворачивается в .exe', () => {
    writeFileSync(join(dir, 'gemini.exe'), 'x');
    expect(resolveWindowsExecutable('gemini', env(dir))).toBe(join(dir, 'gemini.exe'));
  });

  it('только обёртка без бинаря — undefined: без cmd.exe её не запустить', () => {
    writeFileSync(join(dir, 'aider.cmd'), '@echo off');
    expect(resolveWindowsExecutable('aider.cmd', env(dir))).toBeUndefined();
  });

  it('явный путь к .exe проверяется как есть, PATH не при чём', () => {
    const exe = join(dir, 'claude.exe');
    writeFileSync(exe, 'x');
    expect(resolveWindowsExecutable(exe, env(''))).toBe(exe);
    expect(resolveWindowsExecutable(join(dir, 'нет.exe'), env(''))).toBeUndefined();
  });

  it('рядом с указанной обёрткой ищется одноимённый .exe', () => {
    writeFileSync(join(dir, 'opencode.exe'), 'x');
    expect(resolveWindowsExecutable(join(dir, 'opencode.cmd'), env(''))).toBe(
      join(dir, 'opencode.exe'),
    );
  });

  it('каталог с таким именем за исполняемый файл не считается', () => {
    mkdirSync(join(dir, 'qwen.exe'));
    expect(resolveWindowsExecutable('qwen', env(dir))).toBeUndefined();
  });
});

describe('cmdWouldTruncate', () => {
  it('перевод строки в аргументе — команда будет обрезана', () => {
    expect(cmdWouldTruncate(['-p', 'первый вопрос\n\nвторой вопрос'])).toBe(true);
    expect(cmdWouldTruncate(['-p', 'строка\rвозврат'])).toBe(true);
  });

  it('однострочный аргумент проходит', () => {
    expect(cmdWouldTruncate(['-p', 'a&whoami "кавычка" 50%'])).toBe(false);
  });
});
