import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync, writeFileSync } from 'node:fs';
import type { RawEvent } from './chat-events.ts';
import { killChildTree } from '../../lib/process-tree.ts';

/**
 * Живая сессия: ОДИН процесс Claude Code на разговор, а не по процессу на ход.
 *
 * Прежде панель запускала `claude -p` на каждое сообщение, и процесс уходил
 * вместе с концом хода — а с ним и все фоновые команды агента: запущенные
 * `run_in_background` и долгие, которые CLI сам уводит в фон через 600 с. Агент
 * на следующем ходе получал «Background shell command didn't finish before the
 * previous session ended» — тесты, сборка, сервер умирали на полпути.
 *
 * Режим потокового ввода (`--input-format stream-json`) держит процесс между
 * ходами: сообщение уходит строкой JSON в stdin, конец хода — событие `result`,
 * после него процесс ждёт следующего. Замерено 23.09.2026 на claude 2.1.280
 * настоящим запуском: фоновая команда переживает конец хода, а когда она
 * кончается, CLI САМ начинает новый ход (`task_notification` → `init` → ответ
 * агента) — без сообщения человека. Такой ход панель обязана показать, поэтому
 * сессия зовёт `onWake`, а реестр заводит под него обычный прогон.
 *
 * Второй замер того же дня: `usage` в `result` — за ход, а `total_cost_usd`
 * КОПИТСЯ за жизнь процесса. Сессия переводит его в разницу за ход, иначе общий
 * счётчик расхода задваивался бы на каждом следующем ходе.
 */

/** С чем поднят процесс: ходы с другими параметрами в него не отправить. */
export interface LiveLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  /**
   * Всё, от чего зависит командная строка, кроме самого сообщения и ключа
   * прогона. Разные подписи — разные процессы: модель, права, дописка к
   * системному промпту уезжают только аргументами запуска.
   */
  signature: string;
  /** Папка с конфигом брокера прав и дописками — живёт, пока жив процесс. */
  tempDir?: string;
  /** Куда брокер прав смотрит за ключом прогона (см. `permission-prompt-server.mjs`). */
  runIdFile?: string;
}

/** Чем кончился ход для того, кто его ждал. */
export interface TurnOutcome {
  /** Процесс закрылся посреди хода (остановка, падение, сбой запуска). */
  closed: boolean;
  code?: number;
  spawnError?: Error;
  stderr: string;
}

/** Сколько хвоста stderr держим: процесс живёт часами, а нужна причина падения. */
const STDERR_TAIL = 8_192;

type RawSink = (raw: RawEvent) => void;

export class LiveSession {
  readonly signature: string;
  sessionId: string | undefined;
  /** Конец последнего хода (мс) — по нему пул решает, кого закрыть. */
  lastUsedAt: number;
  /** Ход, начатый самим CLI, пока его никто не забрал (см. `claimWake`). */
  onWake?: (session: LiveSession) => void;
  onClose?: (session: LiveSession) => void;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly now: () => number;
  private readonly launch: LiveLaunch;
  private sink: { onRaw: RawSink; resolve: (outcome: TurnOutcome) => void } | undefined;
  private waking: RawEvent[] | undefined;
  private closed = false;
  private exitCode: number | undefined;
  private spawnError: Error | undefined;
  private stderr = '';
  private costSoFar = 0;
  private backgroundTasks = 0;

  constructor(launch: LiveLaunch, now: () => number = Date.now) {
    this.launch = launch;
    this.signature = launch.signature;
    this.lastUsedAt = now();
    this.now = now;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: launch.shell,
      windowsHide: true,
      env: launch.env,
    });
    this.child = child;
    // Сбой запуска приходит событием, а не исключением, и без слушателя уносит
    // весь сервер (см. `ChatRun.run`). То же у stdin: запись в закрывшийся CLI
    // отдаёт EPIPE отдельным `error`.
    child.on('error', (error: Error) => {
      this.spawnError = error;
      this.markClosed(-1);
    });
    child.on('close', (code) => this.markClosed(code ?? 0));
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let raw: RawEvent;
      try {
        raw = JSON.parse(line) as RawEvent;
      } catch {
        // Не JSON — предупреждение CLI, шум.
        return;
      }
      this.route(raw);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** Занята ходом — своим или начатым самим CLI. */
  get busy(): boolean {
    return this.sink !== undefined || this.waking !== undefined;
  }

  /** Идут ли фоновые задачи агента — ради них процесс и держится. */
  get hasBackgroundWork(): boolean {
    return this.backgroundTasks > 0;
  }

  /** Ход, начатый самим CLI, ждёт хозяина. */
  get pendingWake(): boolean {
    return this.waking !== undefined;
  }

  /** Отправить сообщение человека; обещание закрывается концом хода. */
  turn(prompt: string, runId: string | undefined, onRaw: RawSink): Promise<TurnOutcome> {
    if (this.closed) return Promise.resolve(this.outcome());
    if (runId && this.launch.runIdFile) {
      try {
        writeFileSync(this.launch.runIdFile, runId, 'utf8');
      } catch {
        // Без файла брокер возьмёт ключ из окружения — ключ первого хода.
      }
    }
    const done = this.expect(onRaw);
    this.child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
    );
    return done;
  }

  /**
   * Забрать ход, начатый самим CLI: сначала отдаются события, пришедшие до
   * этого, потом живые. `undefined` — такого хода нет (уже кончился).
   */
  claimWake(runId: string | undefined, onRaw: RawSink): Promise<TurnOutcome> | undefined {
    const buffered = this.waking;
    if (!buffered) return undefined;
    if (runId && this.launch.runIdFile) {
      try {
        writeFileSync(this.launch.runIdFile, runId, 'utf8');
      } catch {
        // См. `turn`.
      }
    }
    this.waking = undefined;
    const done = this.expect(onRaw);
    for (const raw of buffered) this.deliver(raw);
    return done;
  }

  /** Закрыть мягко: конец stdin — CLI доделывает и выходит сам. */
  close(): void {
    if (this.closed) return;
    this.child.stdin.end();
    // Страховка: процесс, не вышедший сам, валим деревом.
    setTimeout(() => this.kill(), 10_000).unref();
  }

  /** Убить деревом: на Windows CLI живёт под `cmd.exe`. */
  kill(): void {
    if (this.closed) return;
    killChildTree(this.child);
  }

  private expect(onRaw: RawSink): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      this.sink = { onRaw, resolve };
    });
  }

  private route(event: RawEvent): void {
    let raw = event;
    if (raw.session_id) this.sessionId = raw.session_id;
    if (raw.type === 'system' && raw.subtype === 'background_tasks_changed') {
      const tasks = (raw as { tasks?: unknown }).tasks;
      this.backgroundTasks = Array.isArray(tasks) ? tasks.length : 0;
    }
    if (raw.type === 'result') {
      const total = raw.total_cost_usd ?? 0;
      raw = { ...raw, total_cost_usd: Math.max(0, total - this.costSoFar) };
      this.costSoFar = total;
    }

    if (this.sink) {
      this.deliver(raw);
      return;
    }
    if (this.waking) {
      this.waking.push(raw);
      if (raw.type === 'result') {
        // Ход без хозяина: прогон под него не завели. Он всё равно в транскрипте.
        this.waking = undefined;
        this.lastUsedAt = this.now();
      }
      return;
    }
    // Между ходами CLI шлёт служебное (`commands_changed`, смена фоновых задач);
    // новый ход начинается с `init`.
    if (raw.type === 'system' && raw.subtype === 'init') {
      this.waking = [raw];
      this.onWake?.(this);
    }
  }

  private deliver(raw: RawEvent): void {
    const sink = this.sink;
    if (!sink) return;
    sink.onRaw(raw);
    if (raw.type !== 'result') return;
    this.sink = undefined;
    this.lastUsedAt = this.now();
    sink.resolve({ closed: false, stderr: '' });
  }

  private outcome(): TurnOutcome {
    return {
      closed: true,
      ...(this.exitCode !== undefined ? { code: this.exitCode } : {}),
      ...(this.spawnError ? { spawnError: this.spawnError } : {}),
      stderr: this.stderr.trim(),
    };
  }

  private markClosed(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.waking = undefined;
    const sink = this.sink;
    this.sink = undefined;
    sink?.resolve(this.outcome());
    if (this.launch.tempDir) {
      try {
        rmSync(this.launch.tempDir, { recursive: true, force: true });
      } catch {
        // Подчистит ОС.
      }
    }
    this.onClose?.(this);
  }
}

export interface LivePoolLimits {
  /** Сколько держать процесс без фоновых задач после конца хода. */
  idleMs: number;
  /** То же, пока идут фоновые задачи: ради них сессия и живёт. */
  backgroundIdleMs: number;
  /** Сколько процессов держать разом; лишний закрывается старейший простаивающий. */
  max: number;
}

export const DEFAULT_LIVE_LIMITS: LivePoolLimits = {
  idleMs: 30 * 60_000,
  backgroundIdleMs: 6 * 60 * 60_000,
  max: 12,
};

/**
 * Живые сессии по `sessionId`. Процесс берут под ход, только если он свободен и
 * поднят с теми же параметрами; иначе прежний закрывается, а ход идёт новым
 * процессом с `--resume` — как было до пула.
 */
export class LiveSessionPool {
  /** Ход, начатый самим CLI: реестр заводит под него прогон (см. `ChatRunRegistry.wake`). */
  onWake?: (sessionId: string) => void;

  private readonly sessions = new Map<string, LiveSession>();
  private readonly limits: LivePoolLimits;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(limits: LivePoolLimits = DEFAULT_LIVE_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Есть ли у сессии живой процесс — занятый или ждущий следующего хода. */
  has(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.alive ?? false;
  }

  /**
   * Свободный процесс этой сессии с той же подписью. Чужая подпись — прежний
   * процесс закрывается: разговор продолжится новым, два процесса на одну
   * сессию писали бы в один транскрипт.
   */
  take(sessionId: string | undefined, signature: string): LiveSession | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (!session.alive) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    if (session.busy) return undefined;
    if (session.signature !== signature) {
      this.sessions.delete(sessionId);
      session.close();
      return undefined;
    }
    return session;
  }

  /** Процесс с ходом, начатым самим CLI и ещё никем не забранным. */
  waking(sessionId: string | undefined): LiveSession | undefined {
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /** Принять процесс после хода: он ждёт следующего сообщения. */
  keep(session: LiveSession): void {
    const sessionId = session.sessionId;
    if (!session.alive || !sessionId) {
      session.kill();
      return;
    }
    const previous = this.sessions.get(sessionId);
    if (previous && previous !== session) {
      this.sessions.delete(sessionId);
      previous.close();
    }
    session.onWake = (live) => {
      if (live.sessionId) this.onWake?.(live.sessionId);
    };
    session.onClose = (live) => {
      if (live.sessionId && this.sessions.get(live.sessionId) === live) {
        this.sessions.delete(live.sessionId);
      }
    };
    this.sessions.set(sessionId, session);
    // Ход, начатый CLI в ту же пачку вывода, что и конец прошлого, пришёл, когда
    // слушателя ещё не было, — будим сейчас.
    if (session.pendingWake) queueMicrotask(() => this.onWake?.(sessionId));
    this.enforceMax();
    this.timer ??= setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /** Убрать процесс из пула, не закрывая (его убивает остановка). */
  forget(session: LiveSession): void {
    for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
  }

  /** Закрыть простаивающих дольше предела. */
  sweep(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.busy) continue;
      const limit = session.hasBackgroundWork ? this.limits.backgroundIdleMs : this.limits.idleMs;
      if (now - session.lastUsedAt < limit) continue;
      this.sessions.delete(key);
      session.close();
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private enforceMax(): void {
    while (this.sessions.size > this.limits.max) {
      const idle = [...this.sessions.entries()]
        .filter(([, session]) => !session.busy)
        // Сначала те, кто ничего не ждёт в фоне, потом — давнее простаивающие.
        .sort(
          ([, a], [, b]) =>
            Number(a.hasBackgroundWork) - Number(b.hasBackgroundWork) ||
            a.lastUsedAt - b.lastUsedAt,
        );
      const victim = idle[0];
      if (!victim) return;
      this.sessions.delete(victim[0]);
      victim[1].close();
    }
  }
}
