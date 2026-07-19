import { ChatRun, type ChatEvent, type RunOptions } from './ChatRunner.ts';

/**
 * Реестр прогонов Claude Code, отвязанный от HTTP-запроса.
 *
 * Раньше процесс агента жил ровно столько, сколько держалось соединение: стоило
 * браузеру закрыть вкладку, разорвать связь по таймауту или уйти на переподключение
 * — и `reply.raw.on('close')` убивал агента на полуслове. Работа пропадала, а
 * пользователь видел «зависший» чат и перезагружал страницу.
 *
 * Теперь процесс принадлежит реестру, а не запросу. События копятся в буфер с
 * порядковыми номерами (`seq`); к прогону можно подключиться и переподключиться
 * SSE-потоком, догнав пропущенное с любого `seq`. Обрыв соединения только
 * отцепляет слушателя — сам агент продолжает работать. Завершённый прогон живёт
 * в буфере ещё минуту (на случай переподключения), затем убирается.
 */

/** Событие с порядковым номером — по нему клиент догоняет пропущенное. */
export interface BufferedEvent {
  seq: number;
  event: ChatEvent;
}

/** Живой слушатель одного прогона (открытый SSE-ответ). */
export interface RunSubscriber {
  /** Отдать событие клиенту. */
  send: (buffered: BufferedEvent) => void;
  /** Прогон завершился — закрыть поток слушателя. */
  close: () => void;
}

/** Сведения о прогоне для группировки и переподключения (в т.ч. после F5). */
export interface RunMeta {
  /** Каталог проекта (для группировки статусов); undefined — песочница/дом. */
  projectPath?: string;
  /** Идентификатор сессии на старте (для продолжения разговора). */
  sessionId?: string;
}

/**
 * Минимум, что реестру нужно от прогона: запуститься с колбэком событий и уметь
 * остановиться. `ChatRun` этому соответствует; интерфейс нужен, чтобы в тестах
 * подставлять управляемый фейк вместо запуска настоящего CLI.
 */
export interface RunLike {
  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void>;
  stop(): void;
}

type RunFactory = () => RunLike;

type RunStatus = 'running' | 'done' | 'error' | 'stopped';

interface RegisteredRun {
  chatId: string;
  run: RunLike;
  meta: RunMeta;
  events: BufferedEvent[];
  seq: number;
  status: RunStatus;
  errored: boolean;
  sessionId?: string;
  subscribers: Set<RunSubscriber>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Сколько держать завершённый прогон в буфере — на догон при переподключении. */
const GRACE_MS = 60_000;

export class ChatRunRegistry {
  private runs = new Map<string, RegisteredRun>();
  private readonly createRun: RunFactory;

  /**
   * Фабрика прогона: по умолчанию — настоящий CLI, в тестах — управляемый фейк.
   *
   * Поле присваивается вручную: Node исполняет TypeScript в режиме strip-only
   * и parameter properties не поддерживает — с ними сервер не стартует вовсе.
   */
  constructor(createRun: RunFactory = () => new ChatRun()) {
    this.createRun = createRun;
  }

  /** Идёт ли сейчас прогон с этим chatId. */
  isRunning(chatId: string): boolean {
    return this.runs.get(chatId)?.status === 'running';
  }

  /** Есть ли прогон в реестре (идущий или в буфере после завершения). */
  has(chatId: string): boolean {
    return this.runs.has(chatId);
  }

  /**
   * Запустить прогон, отвязанный от запроса. Если для chatId уже идёт прогон —
   * возвращаем его (защита от двойной отправки), не плодя второй процесс.
   */
  start(chatId: string, options: RunOptions, meta: RunMeta): void {
    const existing = this.runs.get(chatId);
    if (existing && existing.status === 'running') return;
    // Перезапуск поверх завершённого (повтор упавшего) — чистим старый буфер.
    if (existing) this.remove(chatId);

    const run = this.createRun();
    const registered: RegisteredRun = {
      chatId,
      run,
      meta,
      events: [],
      seq: 0,
      status: 'running',
      errored: false,
      sessionId: meta.sessionId,
      subscribers: new Set(),
    };
    this.runs.set(chatId, registered);

    void run
      .start(options, (event) => this.emit(registered, event))
      .then(() => this.finish(registered))
      .catch((error) => {
        this.emit(registered, {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        this.finish(registered);
      });
  }

  /**
   * Внешнее событие в поток прогона (например, запрос прав приходит не от CLI, а
   * от MCP-сервера через HTTP) — с тем же буфером и seq, чтобы пережить
   * переподключение. false — если прогона нет.
   */
  emitExternal(chatId: string, event: ChatEvent): boolean {
    const run = this.runs.get(chatId);
    if (!run) return false;
    this.emit(run, event);
    return true;
  }

  /** Записать событие в буфер и разослать живым слушателям. */
  private emit(run: RegisteredRun, event: ChatEvent): void {
    // Запоминаем sessionId — его отдаёт /chat/active для переподключения после F5.
    if (event.kind === 'session') run.sessionId = event.sessionId;
    if (event.kind === 'done' && event.sessionId) run.sessionId = event.sessionId;
    if (event.kind === 'error') run.errored = true;

    const buffered: BufferedEvent = { seq: ++run.seq, event };
    run.events.push(buffered);
    for (const subscriber of run.subscribers) subscriber.send(buffered);
  }

  /** Прогон завершился сам (процесс закрылся). */
  private finish(run: RegisteredRun): void {
    if (run.status !== 'running') return;
    run.status = run.errored ? 'error' : 'done';
    // Закрываем текущих слушателей, но буфер держим ещё минуту — вдруг клиент
    // переподключается и хочет догнать хвост с терминальным событием.
    for (const subscriber of run.subscribers) subscriber.close();
    run.subscribers.clear();
    run.cleanupTimer = setTimeout(() => this.remove(run.chatId), GRACE_MS);
  }

  /**
   * Подписаться на прогон, начиная со следующего события после `fromSeq`.
   * Сначала догоняем буфер, затем — живые события. Возвращает отписку, либо
   * `undefined`, если прогон уже завершён (буфер отдан, живых событий не будет)
   * или его нет вовсе.
   */
  attach(chatId: string, fromSeq: number, subscriber: RunSubscriber): (() => void) | undefined {
    const run = this.runs.get(chatId);
    if (!run) return undefined;

    for (const buffered of run.events) {
      if (buffered.seq > fromSeq) subscriber.send(buffered);
    }

    if (run.status !== 'running') return undefined;

    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  /** Остановить прогон по кнопке: убить процесс и убрать из реестра. */
  stop(chatId: string): boolean {
    const run = this.runs.get(chatId);
    if (!run) return false;
    run.run.stop();
    if (run.status === 'running') run.status = 'stopped';
    for (const subscriber of run.subscribers) subscriber.close();
    this.remove(chatId);
    return true;
  }

  /** Остановить все прогоны разом. */
  stopAll(): void {
    for (const chatId of [...this.runs.keys()]) this.stop(chatId);
  }

  /** Идущие прогоны — для восстановления просмотра после перезагрузки страницы. */
  active(): { chatId: string; sessionId?: string; projectPath?: string; seq: number }[] {
    const list: { chatId: string; sessionId?: string; projectPath?: string; seq: number }[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      list.push({
        chatId: run.chatId,
        sessionId: run.sessionId,
        projectPath: run.meta.projectPath,
        seq: run.seq,
      });
    }
    return list;
  }

  private remove(chatId: string): void {
    const run = this.runs.get(chatId);
    if (!run) return;
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.subscribers.clear();
    this.runs.delete(chatId);
  }
}
