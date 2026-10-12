import { execFile, spawn } from 'node:child_process';
import type { DockerState } from '@agentdeck/contracts';
import { killChildTree } from '../../lib/process-tree/process-tree.ts';

/**
 * Граница с программой docker. Всё, что домен знает о процессах, — эти два
 * типа: разовая команда с ответом и долгая команда с потоком вывода. Тесты
 * подставляют свои — настоящий docker им не нужен.
 */

export interface ExecResult {
  /** `null` — процесс не дожил до конца (таймаут, убит). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Программы docker нет в PATH. */
  missing?: boolean;
}

export type DockerExec = (args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

export interface DockerJobProcess {
  onOutput(listener: (chunk: string) => void): void;
  /** `missing` — docker не нашёлся; `code` `null` — процесс убит. */
  onExit(listener: (code: number | null, missing: boolean) => void): void;
  kill(): void;
}

export type DockerSpawn = (args: string[], cwd: string) => DockerJobProcess;

const isWindows = process.platform === 'win32';

export const execDocker: DockerExec = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        if (failure.code === 'ENOENT')
          return resolve({ code: null, stdout, stderr, missing: true });
        resolve({
          code: typeof failure.code === 'number' && !failure.killed ? failure.code : null,
          stdout,
          stderr: stderr || failure.message,
        });
      },
    );
  });

export const spawnDocker: DockerSpawn = (args, cwd) => {
  // POSIX: своя группа процессов — чтобы убить сборку вместе с её детьми.
  const child = spawn('docker', args, {
    cwd,
    windowsHide: true,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputListeners: ((chunk: string) => void)[] = [];
  let exitListener: ((code: number | null, missing: boolean) => void) | undefined;
  let finished = false;
  const finish = (code: number | null, missing: boolean): void => {
    if (finished) return;
    finished = true;
    exitListener?.(code, missing);
  };
  const forward = (data: Buffer): void => {
    const text = data.toString('utf8');
    for (const listener of outputListeners) listener(text);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code === 'ENOENT'));
  child.on('close', (code) => finish(code, false));
  return {
    onOutput: (listener) => outputListeners.push(listener),
    onExit: (listener) => {
      exitListener = listener;
    },
    kill: () => killChildTree(child, { group: !isWindows }),
  };
};

/** Вывод docker для человека: без пустых строк и не длиннее подсказки под объяснением. */
export function shortDetail(text: string, limit = 600): string {
  const clean = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

const STATE_TTL_MS = 10_000;

/**
 * Готов ли Docker. `docker info` спрашивает демона: программы нет — `missing`,
 * программа есть, а демон не отвечает (Docker Desktop не запущен) — `stopped`.
 * Ответ живёт 10 секунд: окно опрашивает сервисы каждые 3, а `docker info`
 * при остановленном демоне думает до секунды.
 */
export class DockerStateProbe {
  private cached?: { at: number; state: DockerState; detail?: string };
  private readonly exec: DockerExec;
  private readonly now: () => number;

  constructor(exec: DockerExec, now: () => number = Date.now) {
    this.exec = exec;
    this.now = now;
  }

  async read(cwd: string): Promise<{ state: DockerState; detail?: string }> {
    if (this.cached && this.now() - this.cached.at < STATE_TTL_MS) return this.cached;
    const result = await this.exec(['info', '--format', '{{.ServerVersion}}'], cwd, 15_000);
    const state: DockerState = result.missing ? 'missing' : result.code === 0 ? 'ok' : 'stopped';
    const detail = state === 'stopped' ? shortDetail(result.stderr || result.stdout) : undefined;
    this.cached = { at: this.now(), state, ...(detail ? { detail } : {}) };
    return this.cached;
  }

  /** Действие только что упало на демоне — следующий опрос спросит docker заново. */
  forget(): void {
    this.cached = undefined;
  }
}
