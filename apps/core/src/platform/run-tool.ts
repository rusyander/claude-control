import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { decodeToolOutput, parseOemCodePage } from './encoding.ts';
import { currentOs, envValue, reasonOf, type OsKind } from './os-kind.ts';

/**
 * Запуск внешнего инструмента ОС без оболочки (09: «No shell»): `ps`, `lsof`, `reg`,
 * `schtasks`, `powershell`, `git`, `docker`. Вывод декодируется по правилу кодировки, а
 * таймаут и сбой запуска приходят отдельным ответом — вызывающий превращает их в
 * `unknown`, а не в пустой вывод (F25).
 */

export type ToolRun =
  | { ok: true; code: number | null; stdout: string; stderr: string; timedOut: false }
  | { ok: false; reason: string; timedOut: boolean; code?: number | null; stderr?: string };

export interface ToolOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Ненулевой код — не сбой (например, `schtasks /query` несуществующей задачи). */
  acceptNonZero?: boolean;
  maxBuffer?: number;
  /** Текст на stdin, затем stdin закрыт (SQL миграции внутрь контейнера без временных файлов). */
  input?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

let oemCodePage: number | undefined | null = null;

/** Путь к инструменту System32 целиком: PATH фоновых процессов бывает урезан. */
export function system32(tool: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows', 'System32', tool);
}

export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/**
 * OEM-страница консоли Windows, один раз на процесс; на POSIX — `undefined` (там UTF-8).
 * Читается через `reg.exe` без оболочки: `chcp` — встроенная команда cmd. Запоминается только
 * прочитанная страница (F-114): разовый отказ `reg.exe` (тайм-аут под нагрузкой) иначе на всю
 * жизнь процесса оставлял вывод инструментов нераскодированным.
 */
export async function consoleCodePage(
  os: OsKind = currentOs(),
  query: () => Promise<number | undefined> = queryOemCodePage,
): Promise<number | undefined> {
  if (os !== 'win32') return undefined;
  if (oemCodePage !== null) return oemCodePage;
  const page = await query();
  if (page !== undefined) oemCodePage = page;
  return page;
}

async function queryOemCodePage(): Promise<number | undefined> {
  const run = await runToolRaw(
    system32('reg.exe'),
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
    { timeoutMs: 5_000 },
    undefined,
  );
  return run.ok ? parseOemCodePage(run.stdout) : undefined;
}

export async function runTool(
  file: string,
  args: readonly string[],
  options: ToolOptions = {},
): Promise<ToolRun> {
  const codePage = await consoleCodePage();
  return runToolRaw(file, args, options, codePage);
}

function runToolRaw(
  file: string,
  args: readonly string[],
  options: ToolOptions,
  codePage: number | undefined,
): Promise<ToolRun> {
  return new Promise((done) => {
    try {
      const child = execFile(
        file,
        [...args],
        {
          encoding: 'buffer',
          windowsHide: true,
          shell: false,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          ...(options.env ? { env: options.env } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
        (error, stdoutBytes, stderrBytes) => {
          const stdout = decodeToolOutput(stdoutBytes, codePage);
          const stderr = decodeToolOutput(stderrBytes, codePage);
          if (!error) {
            done({ ok: true, code: 0, stdout, stderr, timedOut: false });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
            code?: number | string | null;
          };
          const timedOut = failure.killed === true && failure.signal !== null;
          const exitCode = typeof failure.code === 'number' ? failure.code : null;
          if (!timedOut && exitCode !== null && options.acceptNonZero) {
            done({ ok: true, code: exitCode, stdout, stderr, timedOut: false });
            return;
          }
          done({
            ok: false,
            reason: timedOut
              ? `timeout after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
              : reasonOf(error),
            timedOut,
            code: exitCode,
            stderr,
          });
        },
      );
      if (options.input !== undefined) {
        // Процесс, не читающий stdin, закрывает трубу раньше: EPIPE — не сбой запуска.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.input);
      }
    } catch (error) {
      done({ ok: false, reason: reasonOf(error), timedOut: false });
    }
  });
}
