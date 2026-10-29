import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { currentOs, envValue, pathDirs, pathListSeparator, type OsKind } from './os-kind.ts';

/**
 * PATH оболочки входа (09 §login-shell PATH, P104, R:S3-21) — ЕДИНСТВЕННОЕ место, где ядро
 * запускает оболочку. Процесс, стартовавший из GUI, launchd или systemd, не видит PATH,
 * который пользователь собрал в `.zshrc`/`.bashrc` (nvm, pyenv, brew): CLI и проверки там
 * «не найдены». Читаем `$SHELL -lic` с stdin = /dev/null (подсказка `read` получает EOF,
 * а не ждёт вечно), 10 с, между метками с разовой солью вокруг `env -0` — баннер rc,
 * приглашение и мусор после выхода не смешиваются с окружением, а напечатать нашу метку
 * заранее rc не может. Зависла, сломалась, меток нет — известные каталоги, причина названа.
 * Windows: PATH не собирается оболочкой входа — неприменимо.
 */

export type LoginPathSource = 'login-shell' | 'known-dirs' | 'not-applicable';

export interface LoginPath {
  path: string;
  source: LoginPathSource;
  /** Почему не оболочка (таймаут, нет меток, выход с кодом …) — показывается, не глотается. */
  reason?: string;
}

export interface LoginPathOptions {
  /** Оболочка (по умолчанию `$SHELL`, иначе `/bin/sh`). */
  shell?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
  /** Каталоги запасного пути после текущего PATH (общие каталоги ОС + данные переходников). */
  knownDirs?: readonly string[];
}

/** Достаёт окружение между метками; `undefined` — меток нет или они не в том порядке. */
export function parseSentinelEnv(
  output: string,
  begin: string,
  end: string,
): Map<string, string> | undefined {
  // Последняя метка начала: rc может напечатать что угодно ДО, но не нашу соль.
  const start = output.lastIndexOf(begin);
  if (start < 0) return undefined;
  const stop = output.indexOf(end, start + begin.length);
  if (stop < 0) return undefined;
  const block = output.slice(start + begin.length, stop);
  const env = new Map<string, string>();
  for (const entry of block.split('\0')) {
    const clean = entry.replace(/^\n/, '');
    const eq = clean.indexOf('=');
    if (eq <= 0) continue;
    env.set(clean.slice(0, eq), clean.slice(eq + 1));
  }
  return env;
}

function fallback(
  env: NodeJS.ProcessEnv,
  os: OsKind,
  known: readonly string[],
  reason: string,
): LoginPath {
  const dirs = [...new Set([...pathDirs(env, os), ...known])];
  return { path: dirs.join(pathListSeparator(os)), source: 'known-dirs', reason };
}

export async function readLoginShellPath(options: LoginPathOptions = {}): Promise<LoginPath> {
  const os = options.os ?? currentOs();
  const env = options.env ?? process.env;
  if (os === 'win32') {
    return {
      path: envValue(env, 'PATH', os) ?? '',
      source: 'not-applicable',
      reason: 'Windows: PATH is not built by a login shell',
    };
  }
  const known = options.knownDirs ?? [];
  const shell = options.shell ?? envValue(env, 'SHELL', os) ?? '/bin/sh';
  if (!path.posix.isAbsolute(shell))
    return fallback(env, os, known, `shell not absolute: ${shell}`);
  const salt = randomBytes(8).toString('hex');
  const begin = `__AGENTDECK_ENV_BEGIN_${salt}__`;
  const end = `__AGENTDECK_ENV_END_${salt}__`;
  // Метки собираются из двух половин: эхо rc с командной строкой (`set -x`) их не подделает.
  const script = `printf '\\n%s%s\\n' '${begin.slice(0, 10)}' '${begin.slice(10)}'; env -0; printf '\\n%s%s\\n' '${end.slice(0, 10)}' '${end.slice(10)}'`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const run = await new Promise<{
    out: string;
    code: number | null;
    timedOut: boolean;
    error?: string;
  }>((done) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(shell, ['-lic', script], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
        shell: false,
      });
    } catch (error) {
      done({
        out,
        code: null,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // Группа целиком: rc мог запустить потомков (`sleep`, агент ssh) — не оставляем их.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // уже вышла
      }
      // Потомок, ушедший в свою сессию (setsid), держит канал вывода — `close` может не
      // прийти никогда; ответ не ждёт его.
      child.stdout.destroy();
      done({ out, code: null, timedOut });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ out, code: null, timedOut, error: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ out, code, timedOut });
    });
  });

  if (run.error) return fallback(env, os, known, `shell did not start: ${run.error}`);
  if (run.timedOut) return fallback(env, os, known, `login shell timed out after ${timeoutMs} ms`);
  const parsed = parseSentinelEnv(run.out, begin, end);
  if (!parsed)
    return fallback(env, os, known, `no sentinel in login shell output (exit ${run.code})`);
  const value = parsed.get('PATH');
  if (!value) return fallback(env, os, known, 'login shell printed no PATH');
  return { path: value, source: 'login-shell' };
}
