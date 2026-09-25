import { rmSync, writeFileSync } from 'node:fs';
import type { RawEvent } from './chat-events.ts';
import {
  connectRelay,
  relayOpener,
  type LiveTransport,
  type RelayAddress,
  type RelaySynced,
  type TransportOpener,
} from './live-transport.ts';

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
 *
 * Трубы CLI держит посредник (`live-relay.mjs`), а не сервер: перезапуск панели
 * закрывал stdin, и CLI уходил в конце хода вместе с фоном (журнал 29, 60, 69).
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
  /** Pid, под которым посредник поднял CLI (оболочка на Windows); прямой запуск — нет. */
  childPid: number | undefined;

  private readonly transport: LiveTransport;
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
  /**
   * Подхвачен посреди хода после перезапуска панели: кончился ли ход, пока
   * сервера не было, скажет только посредник (`relay_synced`).
   */
  private inheritedTurn = false;
  private syncedWaiters: Array<() => void> = [];
  private closedWaiters: Array<() => void> = [];
  private isSynced = false;
  /** Процесс закрывает сама панель (остановка, пул, выход) — это не обрыв. */
  private released = false;

  constructor(launch: LiveLaunch, now: () => number = Date.now, open?: TransportOpener) {
    this.launch = launch;
    this.signature = launch.signature;
    this.lastUsedAt = now();
    this.now = now;
    this.transport = (open ?? relayOpener())(launch, {
      line: (line) => this.onLine(line),
      stderr: (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
      },
      close: (code, error, stderr) => {
        if (error) this.spawnError = error;
        if (stderr) this.stderr = stderr.slice(-STDERR_TAIL);
        this.markClosed(code);
      },
      synced: (info) => this.onSynced(info),
    });
  }

  /**
   * Подключиться к посреднику, пережившему прежний сервер. `inTurn` — журнал
   * застал сессию посреди хода: вывод, накопленный посредником, достаётся
   * прогону, который заберёт этот ход (`claimWake`), а не теряется до `init`.
   */
  static reattach(
    address: RelayAddress,
    launch: LiveLaunch,
    options: { sessionId: string; inTurn: boolean; background?: number; now?: () => number },
  ): LiveSession {
    const session = new LiveSession(launch, options.now, (_launch, handlers) =>
      connectRelay(address, handlers),
    );
    session.sessionId = options.sessionId;
    // Фон из журнала — до первой строки посредника: не дозвонились до него
    // вовсе, а фон был, — это тоже потерянный фон.
    session.backgroundTasks = options.background ?? 0;
    if (options.inTurn) {
      session.waking = [];
      session.inheritedTurn = true;
    }
    return session;
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  /** Канал посредника; нет — процесс поднят напрямую и перезапуск не переживёт. */
  get relay(): RelayAddress | undefined {
    return this.transport.relay;
  }

  /** Папка процесса и файл ключа прогона — в журнал, для подхвата после перезапуска. */
  get files(): { tempDir?: string; runIdFile?: string } {
    return {
      ...(this.launch.tempDir ? { tempDir: this.launch.tempDir } : {}),
      ...(this.launch.runIdFile ? { runIdFile: this.launch.runIdFile } : {}),
    };
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** Рабочая папка процесса: пока он жив, Windows не даст её удалить. */
  get cwd(): string {
    return this.launch.cwd;
  }

  /** Промис выхода процесса; уже вышедший — разрешён сразу. */
  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.closedWaiters.push(resolve));
  }

  /** Занята ходом — своим или начатым самим CLI. */
  get busy(): boolean {
    return this.sink !== undefined || this.waking !== undefined;
  }

  /** Идут ли фоновые задачи агента — ради них процесс и держится. */
  get hasBackgroundWork(): boolean {
    return this.backgroundTasks > 0;
  }

  /** Сколько фоновых задач агента идёт — в журнал прогонов (журнал 64). */
  get backgroundCount(): number {
    return this.backgroundTasks;
  }

  /**
   * Процесс ушёл сам (упал, снят снаружи, посредник закрыл простой), держа
   * фоновые задачи: их итогов не будет, и пробуждения тоже. Это обрыв работы, а
   * не её провал (решение W3-4c), — группу продолжают с восстановлением
   * состояния. Закрытое панелью сюда не относится.
   */
  get lostBackground(): boolean {
    return this.closed && !this.released && this.backgroundTasks > 0;
  }

  /** Ход, начатый самим CLI, ждёт хозяина. */
  get pendingWake(): boolean {
    return this.waking !== undefined;
  }

  /** Первая строка посредника пришла (или её не будет: прямой запуск, смерть). */
  whenSynced(timeoutMs = 10_000): Promise<void> {
    if (this.isSynced || this.closed || !this.transport.relay) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.syncedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Отправить сообщение человека; обещание закрывается концом хода. */
  turn(prompt: string, runId: string | undefined, onRaw: RawSink): Promise<TurnOutcome> {
    if (this.closed) return Promise.resolve(this.outcome());
    this.writeRunId(runId);
    const done = this.expect(onRaw);
    this.transport.write(
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
    this.writeRunId(runId);
    this.waking = undefined;
    const done = this.expect(onRaw);
    for (const raw of buffered) this.deliver(raw);
    return done;
  }

  /** Закрыть мягко: конец stdin — CLI доделывает и выходит сам. */
  close(): void {
    if (this.closed) return;
    this.released = true;
    this.transport.end();
    // Страховка: процесс, не вышедший сам, валим деревом.
    setTimeout(() => this.kill(), 10_000).unref();
  }

  /** Убить деревом: на Windows CLI живёт под `cmd.exe`. */
  kill(): void {
    if (this.closed) return;
    this.released = true;
    this.transport.kill();
  }

  /**
   * Сервер уходит, процесс остаётся: подключение к посреднику рвётся молча, а
   * папка процесса не убирается — в ней конфиг брокера прав, и новый сервер
   * найдёт её по журналу. Прямой запуск без сервера не живёт — он гаснет.
   */
  detach(): void {
    if (this.closed) return;
    this.released = true;
    this.transport.detach();
  }

  private writeRunId(runId: string | undefined): void {
    if (!runId || !this.launch.runIdFile) return;
    try {
      writeFileSync(this.launch.runIdFile, runId, 'utf8');
    } catch {
      // Без файла брокер возьмёт ключ из окружения — ключ первого хода.
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let raw: RawEvent;
    try {
      raw = JSON.parse(line) as RawEvent;
    } catch {
      // Не JSON — предупреждение CLI, шум.
      return;
    }
    this.route(raw);
  }

  private onSynced(info: RelaySynced): void {
    this.backgroundTasks = info.background;
    if (info.childPid !== undefined) this.childPid = info.childPid;
    this.isSynced = true;
    for (const waiter of this.syncedWaiters.splice(0)) waiter();
    if (!this.inheritedTurn) return;
    this.inheritedTurn = false;
    if (info.busy) return;
    // Ход кончился до перезапуска: его `result` ушёл прежнему серверу, и
    // накопленный вывод посредника его не несёт — ждать нечего. Ответ прогон
    // дочитает из транскрипта.
    this.lastUsedAt = this.now();
    this.waking = undefined;
    const sink = this.sink;
    this.sink = undefined;
    sink?.resolve({ closed: false, stderr: '' });
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
    for (const waiter of this.syncedWaiters.splice(0)) waiter();
    for (const waiter of this.closedWaiters.splice(0)) waiter();
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
  /**
   * Процесс из пула закрылся — между ходами или посреди. Реестру: запись о нём
   * в журнале прогонов больше не бережёт ничего живого.
   */
  onClosed?: (session: LiveSession) => void;
  /**
   * Потолок процессов превышен, а вытеснить некого: все заняты ходом или
   * держат фоновую работу. Процессы не закрываются — об этом говорится (Д17).
   */
  onOverflow?: (size: number, max: number) => void;
  /**
   * Чем поднимать новый процесс. По умолчанию — через посредника: CLI
   * переживает перезапуск панели (`live-relay.mjs`).
   */
  readonly open: TransportOpener;

  private readonly sessions = new Map<string, LiveSession>();
  private readonly limits: LivePoolLimits;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    limits: LivePoolLimits = DEFAULT_LIVE_LIMITS,
    now: () => number = Date.now,
    open?: TransportOpener,
  ) {
    this.limits = limits;
    this.now = now;
    this.open =
      open ?? relayOpener({ idleMs: limits.idleMs, backgroundIdleMs: limits.backgroundIdleMs });
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Процесс сессии держит фоновую работу агента (Д3). */
  backgroundOf(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    return Boolean(session?.alive && session.hasBackgroundWork);
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
      this.onClosed?.(live);
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

  /**
   * Закрыть простаивающие процессы, чья рабочая папка внутри `dir` (уборка копии
   * группы, отмена плана). Простой CLI держит папку своим cwd: Windows не отдаёт
   * её на удаление, и `git worktree remove` оставлял полкопии — файлы стёрты,
   * копия снята с учёта, пустой каталог заперт (живой прогон 25.09). Занятый ходом
   * или фоном процесс не закрывается — его работа важнее уборки. Есть хоть один
   * такой — не закрывается никто (`busy` > 0): уборка всё равно откажет, и
   * гасить ради неё остальных незачем. `closed` — когда вышли все закрытые.
   */
  closeIdleIn(
    dir: string,
    /**
     * Гасить деревом (уборка копии): мягкий конец ввода выпускает сам CLI, а его
     * MCP-серверы с тем же cwd живут ещё секунды — папку держат они (F4c). Простой
     * процесс без хода и фона деревом гасить не жалко: разговор уже на диске.
     */
    options: { tree?: boolean } = {},
  ): { busy: number; closed: Promise<void> } {
    const root = comparablePath(dir);
    const inside = [...this.sessions].filter(([, session]) => {
      const cwd = comparablePath(session.cwd);
      return session.alive && (cwd === root || cwd.startsWith(`${root}/`));
    });
    const busy = inside.filter(([, session]) => session.busy || session.hasBackgroundWork).length;
    if (busy > 0) return { busy, closed: Promise.resolve() };
    const exits = inside.map(([key, session]) => {
      this.sessions.delete(key);
      const exit = session.whenClosed();
      if (options.tree) session.kill();
      else session.close();
      return exit;
    });
    return { busy: 0, closed: Promise.all(exits).then(() => undefined) };
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Выход сервера: процессы за посредниками живут дальше, пул их только отпускает. */
  detachAll(): void {
    for (const session of this.sessions.values()) session.detach();
    this.sessions.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private enforceMax(): void {
    while (this.sessions.size > this.limits.max) {
      // Процесс с фоновой задачей не вытесняем никогда (Д17): закрыть его —
      // убить задачу агента, и пробуждения после неё не будет, ребёнок просто
      // замолчит. Лишний процесс сверх потолка дешевле потерянной работы.
      const idle = [...this.sessions.entries()]
        .filter(([, session]) => !session.busy && !session.hasBackgroundWork)
        .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
      const victim = idle[0];
      if (!victim) {
        this.onOverflow?.(this.sessions.size, this.limits.max);
        return;
      }
      this.sessions.delete(victim[0]);
      victim[1].close();
    }
  }
}

/** Путь для сравнения: прямые слэши, без хвостового, без регистра. */
function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
