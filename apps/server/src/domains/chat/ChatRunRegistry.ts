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
  /** Момент завершения (мс) — окно grace, в котором прогон ещё в буфере. */
  finishedAt?: number;
  /**
   * Расход, накопленный ИМЕННО этим прогоном. Нужен, чтобы при ретрае поверх
   * упавшей попытки откатить её вклад из общего счётчика — иначе он задвоится.
   */
  spentCostUsd: number;
  spentTokens: number;
}

/** Сколько держать завершённый прогон в буфере — на догон при переподключении. */
const GRACE_MS = 60_000;

export class ChatRunRegistry {
  private runs = new Map<string, RegisteredRun>();
  private readonly createRun: RunFactory;

  /** Накопленный за сеанс сервера расход — переживает перезагрузку вкладки. */
  private totalCostUsd = 0;
  private totalTokens = 0;

  /**
   * Фабрика прогона: по умолчанию — настоящий CLI, в тестах — управляемый фейк.
   *
   * Поле присваивается вручную: Node исполняет TypeScript в режиме strip-only
   * и parameter properties не поддерживает — с ними сервер не стартует вовсе.
   */
  constructor(createRun: RunFactory = () => new ChatRun()) {
    this.createRun = createRun;
  }

  /**
   * Ключ, под которым разговор ДЕЙСТВИТЕЛЬНО зарегистрирован.
   *
   * Один разговор приходит в двух написаниях: свежий чат стартует под временным
   * `new-<ts>`, а он же, открытый из списка (в соседней вкладке), — уже под
   * своим `sessionId`. Ключ строго по chatId эти написания не сводил: проверка
   * «прогон уже идёт» промахивалась, и на один разговор поднималось ДВА
   * процесса CLI — оба писали в те же файлы и в тот же транскрипт. Поэтому
   * ищем: точное совпадение → прогон, чей sessionId равен пришедшему chatId →
   * совпадение по самому sessionId (в обе стороны). Ничего не нашли — ключом
   * остаётся chatId (новый разговор).
   */
  resolveKey(chatId: string, sessionId?: string): string {
    if (this.runs.has(chatId)) return chatId;
    for (const [key, run] of this.runs) if (run.sessionId === chatId) return key;
    if (sessionId) {
      if (this.runs.has(sessionId)) return sessionId;
      for (const [key, run] of this.runs) if (run.sessionId === sessionId) return key;
    }
    return chatId;
  }

  /** Идёт ли сейчас прогон этого разговора (в любом из написаний ключа). */
  isRunning(chatId: string, sessionId?: string): boolean {
    return this.runs.get(this.resolveKey(chatId, sessionId))?.status === 'running';
  }

  /** Есть ли прогон в реестре (идущий или в буфере после завершения). */
  has(chatId: string): boolean {
    return this.runs.has(this.resolveKey(chatId));
  }

  /**
   * Запустить прогон, отвязанный от запроса. Второй процесс на тот же chatId не
   * плодим, но и молча глотать новый промпт нельзя: раньше `start` просто
   * выходил, а маршрут подключался к ИДУЩЕМУ прогону с seq 0 — пользователю
   * перепечатывался прошлый ответ, а его сообщение не доходило ни до агента, ни
   * до транскрипта. Поэтому возвращаем признак: false — прогон уже идёт, промпт
   * НЕ принят, вызывающий обязан сказать об этом человеку.
   */
  start(chatId: string, options: RunOptions, meta: RunMeta): boolean {
    // Ищем прогон по ОБОИМ написаниям ключа (см. resolveKey): иначе вторая
    // вкладка того же разговора заводила второй процесс мимо этой проверки.
    const existingKey = this.resolveKey(chatId, meta.sessionId);
    const existing = this.runs.get(existingKey);
    if (existing && existing.status === 'running') return false;
    // Перезапуск поверх завершённого (повтор упавшего) — чистим старый буфер.
    // Если прошлый прогон УПАЛ, его расход уже осел в общем счётчике, а ретрай
    // посчитает всё заново — поэтому вклад упавшей попытки откатываем, чтобы он
    // не задвоился. Успешный (done) прогон свой расход сохраняет: это
    // состоявшийся ход разговора, а не отменённая попытка.
    if (existing) {
      if (existing.status === 'error') {
        this.totalCostUsd -= existing.spentCostUsd;
        this.totalTokens -= existing.spentTokens;
      }
      this.remove(existingKey);
    }

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
      spentCostUsd: 0,
      spentTokens: 0,
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

    return true;
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

    // Накопленный расход считаем здесь, на сервере: тогда счётчик за сеанс не
    // обнуляется при перезагрузке вкладки, как и сами прогоны. Дублируем вклад в
    // самом прогоне (spent*) — чтобы при ретрае упавшей попытки откатить именно
    // её долю из общего счётчика, а не гадать.
    if (event.kind === 'usage') {
      const tokens = event.input + event.output + event.cacheRead + event.cacheCreation;
      run.spentTokens += tokens;
      this.totalTokens += tokens;
    }
    if (event.kind === 'done') {
      run.spentCostUsd += event.costUsd;
      this.totalCostUsd += event.costUsd;
    }

    const buffered: BufferedEvent = { seq: ++run.seq, event };
    run.events.push(buffered);
    for (const subscriber of run.subscribers) subscriber.send(buffered);
  }

  /** Прогон завершился сам (процесс закрылся). */
  private finish(run: RegisteredRun): void {
    if (run.status !== 'running') return;
    run.status = run.errored ? 'error' : 'done';
    run.finishedAt = Date.now();
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
    // По ключу-синониму тоже: вкладка, узнавшая о прогоне под sessionId, должна
    // суметь подключиться к нему, даже если он зарегистрирован под `new-…`.
    const run = this.runs.get(this.resolveKey(chatId));
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
    // Ключ-синоним: «Остановить» из вкладки, знающей разговор по sessionId,
    // обязано убить процесс, поднятый под временным `new-…`, — иначе кнопка
    // молча отвечала бы «прогона нет», а агент продолжал работать.
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run) return false;
    try {
      run.run.stop();
    } catch {
      // Убить процесс не вышло (уже умер, отказано в доступе) — но реестр и
      // подписчиков всё равно закрываем: иначе исключение отсюда оставило бы
      // прогон «идущим» навсегда, кнопка «Остановить» больше ничего бы не
      // делала, а `stopAll` при выходе панели споткнулся бы на первом же таком.
    }
    if (run.status === 'running') run.status = 'stopped';
    for (const subscriber of run.subscribers) subscriber.close();
    this.remove(key);
    return true;
  }

  /** Остановить все прогоны разом. */
  stopAll(): void {
    for (const chatId of [...this.runs.keys()]) this.stop(chatId);
  }

  /**
   * Прогоны для восстановления просмотра после перезагрузки страницы: идущие —
   * чтобы дочитать живой поток; плюс недавно завершённые УСПЕШНО (в пределах
   * grace) — чтобы лента догнала их терминальный хвост (done/расход/точку
   * статуса), если прогон закончился, пока вкладка была закрыта, а не только
   * перечитала историю. Упавшие сюда не берём: заново отдавать поток с ошибкой
   * (и, возможно, ловить авто-ретрай) незачем.
   */
  active(): { chatId: string; sessionId?: string; projectPath?: string; seq: number }[] {
    const now = Date.now();
    const list: { chatId: string; sessionId?: string; projectPath?: string; seq: number }[] = [];
    for (const run of this.runs.values()) {
      const recentlyDone =
        run.status === 'done' && run.finishedAt !== undefined && now - run.finishedAt <= GRACE_MS;
      if (run.status !== 'running' && !recentlyDone) continue;
      list.push({
        chatId: run.chatId,
        sessionId: run.sessionId,
        projectPath: run.meta.projectPath,
        seq: run.seq,
      });
    }
    return list;
  }

  /** Накопленный за сеанс сервера расход — для счётчика в пульте агентов. */
  spend(): { costUsd: number; tokens: number } {
    return { costUsd: this.totalCostUsd, tokens: this.totalTokens };
  }

  private remove(chatId: string): void {
    const run = this.runs.get(chatId);
    if (!run) return;
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.subscribers.clear();
    this.runs.delete(chatId);
  }
}
