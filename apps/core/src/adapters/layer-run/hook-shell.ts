import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { OsKind } from '../../platform/os-kind.ts';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import { gitBashNextTo } from '../../platform/git-bash.ts';

/**
 * Оболочка, которой CLI исполняет команду хука, — запись `observe` повторяет её, иначе вердикт
 * записи разошёлся бы с вердиктом самого хука. Claude Code на Windows идёт через Git Bash (проба:
 * `$0` = `/usr/bin/bash`): `CLAUDE_CODE_GIT_BASH_PATH`, иначе `bash.exe` рядом с `git` из PATH
 * (`<git>/cmd/git.exe` → `<git>/bin/bash.exe`). POSIX — `/bin/sh -c` (R3: не проверено живым CLI).
 * Команда человека — одним словом после `-c`, без разбора и без `shell: true`.
 */

export type HookShell = { ok: true; file: string; args: string[] } | { ok: false; reason: string };

const GIT_BASH_VAR = 'CLAUDE_CODE_GIT_BASH_PATH';

export function hookShell(env: Record<string, string | undefined>, os: OsKind): HookShell {
  if (os !== 'win32') return { ok: true, file: '/bin/sh', args: ['-c'] };
  const set = env[GIT_BASH_VAR];
  if (set) {
    return existsSync(set)
      ? { ok: true, file: set, args: ['-c'] }
      : { ok: false, reason: `${GIT_BASH_VAR} points to a missing file: ${set}` };
  }
  const git = resolveExecutable('git', { env, os });
  const bash = git.ok ? gitBashNextTo(git.file) : null;
  if (bash !== null) return { ok: true, file: bash, args: ['-c'] };
  return { ok: false, reason: 'Git Bash not found (no git on PATH, no CLAUDE_CODE_GIT_BASH_PATH)' };
}

export interface HookRun {
  /** Код выхода; `null` — не запустилась, оборвана сроком или сигналом. */
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Почему не запустилась. */
  error?: string;
}

const CAP = 1 << 20;

/** Исполнить команду хука: тот же stdin, то же окружение, срок CLI; дерево гасится по сроку. */
export function runHookCommand(input: {
  shell: { file: string; args: string[] };
  command: string;
  stdin: string;
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs: number;
}): Promise<HookRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (run: HookRun) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(run);
    };
    let child;
    try {
      child = spawn(input.shell.file, [...input.shell.args, input.command], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exit: null, stdout, stderr, timedOut, error: (error as Error).message });
      return;
    }
    // По сроку — ответ сразу, не по `close`: внук оболочки держал бы каналы открытыми, и запись
    // ждала бы его дольше срока самого CLI.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish({ exit: null, stdout, stderr, timedOut });
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < CAP) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      finish({ exit: null, stdout, stderr, timedOut, error: error.message }),
    );
    child.on('close', (code) => finish({ exit: timedOut ? null : code, stdout, stderr, timedOut }));
    // Хук, который stdin не читает, закрывает его раньше: EPIPE — не сбой хука.
    child.stdin.on('error', () => {});
    child.stdin.end(input.stdin);
  });
}

export type HookVerdict = 'allow' | 'wouldBlock' | 'error';

/**
 * Вердикт хука по правилам Claude Code: код 2 — отказ; код 0 с JSON `decision: block`,
 * `continue: false` или `permissionDecision: deny` — отказ; другой ненулевой код, срок,
 * незапуск — сбой (CLI его не считает отказом).
 */
export function hookVerdict(run: HookRun): HookVerdict {
  if (run.exit === 2) return 'wouldBlock';
  if (run.exit !== 0) return 'error';
  const text = run.stdout.trim();
  if (!text.startsWith('{')) return 'allow';
  try {
    const out = JSON.parse(text) as Record<string, unknown>;
    const specific = out.hookSpecificOutput as Record<string, unknown> | undefined;
    if (out.decision === 'block' || out.continue === false) return 'wouldBlock';
    if (specific?.permissionDecision === 'deny') return 'wouldBlock';
    if ((specific?.decision as Record<string, unknown> | undefined)?.behavior === 'deny') {
      return 'wouldBlock';
    }
  } catch {
    // Не JSON — обычный вывод хука: отказа в нём нет.
  }
  return 'allow';
}
