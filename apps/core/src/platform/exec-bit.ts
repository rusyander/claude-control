import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { encodePowerShell, psQuote } from './hidden-launch.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { currentOs, reasonOf, type OsKind } from './os-kind.ts';

/**
 * Исполняемость того, что ставит ядро (P105): хуки, обёртки PATH проверок, прокладки.
 * Режим при создании режется umask (`077` даёт 0700 — чужой агент-пользователь не
 * запустит, `0o755 & ~umask` — не 0755), копия из zip/git без бита — 0644: файл есть, а
 * CLI получает EACCES и молча не зовёт хук. Поэтому режим ставится явно `chmod` ПОСЛЕ
 * записи и читается назад, а `access(X_OK)` ловит том с `noexec`. Windows: бита нет —
 * исполняемость задаёт расширение, ответ называет неприменимость.
 */

export const EXEC_MODE = 0o755;

export type ExecBitOutcome =
  { ok: true; mode: number } | { ok: true; notApplicable: string } | { ok: false; reason: string };

/** Поставить 0755 на существующий файл и проверить чтением назад. */
export function ensureExecBit(file: string, os: OsKind = currentOs()): ExecBitOutcome {
  if (os === 'win32')
    return { ok: true, notApplicable: 'Windows: no exec bit, the extension decides' };
  try {
    chmodSync(file, EXEC_MODE);
    const mode = statSync(file).mode & 0o777;
    if (mode !== EXEC_MODE)
      return { ok: false, reason: `mode ${mode.toString(8)} after chmod 755` };
    accessSync(file, constants.X_OK);
    return { ok: true, mode };
  } catch (error) {
    // EACCES при 0755 — том смонтирован с noexec: называется, а не «установлено».
    return { ok: false, reason: reasonOf(error) };
  }
}

/** Слово в одинарных кавычках sh: внутри них не раскрывается ничего. */
export function shWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Обёртка `#!/bin/sh`, которая исполняет `argv` с аргументами вызова (`"$@"`). Путь в sh —
 * с прямыми косыми: на Windows обёртку запускает Git Bash, обратная косая там — экранирование.
 */
export function shellWrapperScript(argv: readonly string[], os: OsKind = currentOs()): string {
  const words = argv.map((word, i) => shWord(i === 0 && os === 'win32' ? toSlashes(word) : word));
  return `#!/bin/sh\nexec ${words.join(' ')} "$@"\n`;
}

/** Обёртка sh на диске: 0755 и чтение режима назад (P105), как у каждого файла ядра. */
export function writeShellWrapper(
  file: string,
  argv: readonly string[],
  os: OsKind = currentOs(),
): ExecBitOutcome {
  return writeExecutable(file, shellWrapperScript(argv, os), os);
}

/**
 * `<имя>.cmd` для Windows: `cmd` (и всё, что запускает через оболочку) ищет по PATHEXT и берёт его
 * раньше настоящего `<имя>.exe` — каталог обёрток первый в PATH. Запуск мимо оболочки
 * (CreateProcess дописывает только `.exe`) обёртку не видит — граница 03 §Capture.
 * `note` — строка `rem` для человека, открывшего файл: зачем эта обёртка стоит перед инструментом.
 */
export function cmdWrapperScript(argv: readonly string[], note?: string): string {
  return [
    '@echo off',
    // Перевод строки в `rem` начал бы новую команду cmd — заметка одной строкой.
    ...(note ? [`rem agentdeck: ${note.replace(/[\r\n]+/g, ' ')}`] : []),
    // `%` в файле .cmd раскрывается и в кавычках — удваивается; прочие метазнаки — в кавычках.
    `${argv.map((word) => (/[\s&()^%!|<>]/.test(word) ? `"${word.replace(/%/g, '%%')}"` : word)).join(' ')} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/**
 * Обёртка PATH на диске: sh везде (на Windows её берёт Git Bash), на Windows ещё `.cmd` рядом —
 * для `cmd` и оболочек по PATHEXT. Итог каждого записанного файла: обёртка встала, только если
 * встали все.
 */
export function writePathWrapper(
  file: string,
  argv: readonly string[],
  os: OsKind = currentOs(),
  note?: string,
): ExecBitOutcome[] {
  const sh = writeShellWrapper(file, argv, os);
  if (os !== 'win32') return [sh];
  return [sh, writeExecutable(`${file}.cmd`, cmdWrapperScript(argv, note), os)];
}

const toSlashes = (value: string): string => value.replace(/\\/g, '/');

const shortNames = new Map<string, string | null>();

/**
 * Короткое имя 8.3 существующего пути Windows — слово без пробелов для команд, которые CLI
 * исполняет без кавычек (Qwen берёт команду хука только словами без пробелов, а node лежит в
 * `C:\Program Files\nodejs`). `null` — имени нет (8.3 выключены на томе, пути нет) или в нём
 * всё ещё пробел: вызывающий оставляет путь как есть и получает отказ CLI с причиной.
 * Скрипт идёт `-EncodedCommand`, путь — строкой PowerShell (`psQuote`): ни одна кавычка пути
 * не доходит до разбора командной строки. Ответ запоминается на путь.
 */
export function windowsShortPath(path: string): string | null {
  const known = shortNames.get(path);
  if (known !== undefined) return known;
  const p = psQuote(path);
  const script = [
    // Имя пользователя кириллицей: без UTF-8 ответ пришёл бы в кодовой странице консоли.
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$fso = New-Object -ComObject Scripting.FileSystemObject',
    `if (Test-Path -LiteralPath ${p} -PathType Leaf) { $fso.GetFile(${p}).ShortPath }`,
    `elseif (Test-Path -LiteralPath ${p} -PathType Container) { $fso.GetFolder(${p}).ShortPath }`,
  ].join('\n');
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  const short = usableShortPath(run.status === 0 ? run.stdout : '');
  shortNames.set(path, short);
  return short;
}

/** Ответ FSO годится, только если это существующий путь без пробелов (8.3 выключены — пробел). */
export function usableShortPath(stdout: string): string | null {
  const out = stdout.trim();
  return out !== '' && !/\s/.test(out) && existsSync(out) ? out : null;
}

/** Записать исполняемый файл атомарно (LF как есть) и сделать его исполняемым. */
export function writeExecutable(
  file: string,
  content: string,
  os: OsKind = currentOs(),
): ExecBitOutcome {
  try {
    writeFileAtomic(file, content, { mode: EXEC_MODE, os });
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  return ensureExecBit(file, os);
}
