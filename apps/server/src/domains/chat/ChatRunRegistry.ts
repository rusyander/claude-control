import type { RemoteNotifyKind } from '@claude-control/contracts';
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

/**
 * Повод дёрнуть человека на телефоне: работа кончилась или упёрлась в вопрос.
 * Текста здесь нет намеренно — реестр не знает языка интерфейса, а состав
 * уведомления собирает тот, кто его отправляет.
 */
export interface RunNotice {
  kind: RemoteNotifyKind;
  chatId: string;
  projectPath?: string;
  /** Инструмент, который просит разрешения, — только у `permission`. */
  toolName?: string;
}

/**
 * Завершившийся прогон глазами планировщика продолжения: чем он был запущен, в
 * каком каталоге шёл, чем кончился и что успел сказать. Больше реестр о прогоне
 * не знает — и знать не должен, вся логика продолжения живёт снаружи.
 */
export interface RunFinished {
  chatId: string;
  sessionId?: string;
  projectPath?: string;
  /** Хвост ответа агента — в нём ищется блок предложения. */
  text: string;
  /** Прогон закончился без ошибки (лимит и остановка тоже приходят ошибкой). */
  ok: boolean;
  startedAt: number;
  options: RunOptions;
  /** Окно контекста на последнем шаге; 0 — расход не приходил (чужой CLI, ошибка). */
  contextTokens: number;
}

/** Событие с порядковым номером — по нему клиент догоняет пропущенное. */
/** Идущий прогон глазами вкладки, которая его подхватывает после перезагрузки. */
export interface ActiveRunInfo {
  chatId: string;
  sessionId?: string;
  projectPath?: string;
  seq: number;
  /** Когда прогон заведён, по часам сервера — тем же, что пишут транскрипт. */
  startedAt: number;
}

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
  /** С чем прогон стартовал: продолжение в чистой сессии идёт теми же. */
  options: RunOptions;
  /** Момент старта (мс) — по нему видно, обновлён ли файл-опора этим прогоном. */
  startedAt: number;
  /** Хвост ответа агента: в нём ищется блок предложения продолжить. */
  text: string;
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
  /**
   * Размер окна на последнем шаге — вход целиком (свежий, из кэша и записанный
   * в кэш). Это НЕ накопленный расход `spentTokens`: тот растёт от каждого шага,
   * а здесь — сколько контекста перевыставит СЛЕДУЮЩИЙ запрос. Именно по этому
   * числу видно, что разговор пора продолжать с чистого листа.
   */
  contextTokens: number;
}

/** Токены одного шага — то, из чего считается его цена. */
export interface StepTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h?: number;
}

/** Сколько держать завершённый прогон в буфере — на догон при переподключении. */
const GRACE_MS = 60_000;

/**
 * Сколько последних символов ответа держим ради разбора блока продолжения.
 * Хвоста хватает: блок агент выводит в самом конце хода, а хранить целиком
 * ответы всех прогонов сервера значило бы держать в памяти мегабайты текста,
 * который уже лежит в транскрипте.
 */
const TEXT_TAIL = 32_768;

export class ChatRunRegistry {
  private runs = new Map<string, RegisteredRun>();
  private readonly createRun: RunFactory;

  /** Накопленный за сеанс сервера расход — переживает перезагрузку вкладки. */
  private totalCostUsd = 0;
  private totalTokens = 0;

  /**
   * Разговоры, которым больше не подсовываем инициативу «раздели задачи».
   *
   * Инициатива дописывается к КАЖДОМУ прогону, поэтому без такой отметки агент
   * предлагает делить снова и снова — и на «убери лишние импорты в трёх файлах»
   * тоже. Отказавшийся один раз отказался не от формулировки, а от дробления;
   * согласившийся уже разделил, и предлагать ему то же самое повторно незачем.
   * Кнопка «Разделить задачи» работает всегда: она просит прямо, а не стоит за
   * спиной.
   *
   * Живёт здесь, а не в `ChatSession`, по одной причине: реестр — единственный
   * объект, который видят ОБА маршрута, где эта отметка нужна (запуск прогона и
   * само разделение). В памяти и без срока: после перезапуска панели разговор
   * начинается с чистой головы, и одно предложение на новую жизнь чата — не
   * назойливость.
   */
  private readonly splitMuted = new Set<string>();

  /** Больше не предлагать разделение в этом разговоре. */
  muteSplit(chatId: string): void {
    this.splitMuted.add(chatId);
  }

  /** Подсовывать ли инициативу разделения этому разговору. */
  isSplitMuted(chatId: string): boolean {
    return this.splitMuted.has(chatId);
  }

  /**
   * Оценка стоимости шага. Ставится снаружи (маршрутами): тарифы живут в кэше
   * прайса и в настройках пользователя, а реестр про них ничего не знает и
   * знать не должен. Не задана — цена шага просто не показывается.
   */
  private estimateStepCost?: (model: string, tokens: StepTokens) => number;

  setCostEstimator(estimate: (model: string, tokens: StepTokens) => number): void {
    this.estimateStepCost = estimate;
  }

  /**
   * Куда сообщить, что прогон закончился или требует человека. Ставится снаружи
   * по той же причине, что и оценка цены: устройства и настройка уведомлений
   * живут в состоянии панели, а реестр про него не знает. Не задан — молчим.
   */
  private notify?: (notice: RunNotice) => void;

  setNotifier(notify: (notice: RunNotice) => void): void {
    this.notify = notify;
  }

  /**
   * Что делать с завершившимся прогоном, если агент предложил продолжить работу
   * в чистой сессии. Ставится снаружи по той же причине, что и оценка цены:
   * предохранители, настройки и цепочки живут в домене, а реестр знает только
   * про прогоны. Не задан — продолжений не бывает вовсе.
   *
   * Планировщик СИНХРОННЫЙ намеренно: его событие обязано попасть в поток до
   * того, как прогон закроет слушателей, иначе вкладка узнает о новом разговоре
   * только следующим опросом — и несколько секунд будет показывать законченный.
   */
  private planHandoff?: (finished: RunFinished) => ChatEvent | undefined;

  setHandoffPlanner(plan: (finished: RunFinished) => ChatEvent | undefined): void {
    this.planHandoff = plan;
  }

  /**
   * Прогон назвал свой настоящий `sessionId`. Ставится снаружи по той же
   * причине, что и остальные крючки: реестр знает про прогоны, а что делать с
   * этим знанием — дело домена. Сейчас слушатель ровно один: разделение задач
   * переносит на настоящий ключ связь «родитель → потомок», иначе дерево чатов
   * распадалось бы ровно в тот момент, когда временный ключ сменяется живым.
   */
  private onSession?: (chatId: string, sessionId: string) => void;

  setSessionListener(listener: (chatId: string, sessionId: string) => void): void {
    this.onSession = listener;
  }

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
      options,
      startedAt: Date.now(),
      text: '',
      events: [],
      seq: 0,
      status: 'running',
      errored: false,
      sessionId: meta.sessionId,
      subscribers: new Set(),
      spentCostUsd: 0,
      spentTokens: 0,
      contextTokens: 0,
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
    // По ключу-синониму тоже: запрос прав приходит с ключом, под которым прогон
    // заведён, но решение о нём могла принять вкладка, знающая разговор по
    // sessionId, — оба написания обязаны попасть в тот же буфер.
    const run = this.runs.get(this.resolveKey(chatId));
    if (!run) return false;
    this.emit(run, event);
    return true;
  }

  /** Записать событие в буфер и разослать живым слушателям. */
  private emit(run: RegisteredRun, event: ChatEvent): void {
    // Запоминаем sessionId — его отдаёт /chat/active для переподключения после F5.
    const knownSession = run.sessionId;
    if (event.kind === 'session') run.sessionId = event.sessionId;
    if (event.kind === 'done' && event.sessionId) run.sessionId = event.sessionId;
    // Ключ разговора стал настоящим — сообщаем ровно один раз, на смене.
    if (run.sessionId && run.sessionId !== knownSession) {
      this.onSession?.(run.chatId, run.sessionId);
    }
    if (event.kind === 'error') run.errored = true;
    // Текст копим ХВОСТОМ: планировщику продолжения нужен конец ответа, а не
    // весь разговор (см. TEXT_TAIL).
    if (event.kind === 'text') {
      run.text = (run.text + event.text).slice(-TEXT_TAIL);
    }

    // Накопленный расход считаем здесь, на сервере: тогда счётчик за сеанс не
    // обнуляется при перезагрузке вкладки, как и сами прогоны. Дублируем вклад в
    // самом прогоне (spent*) — чтобы при ретрае упавшей попытки откатить именно
    // её долю из общего счётчика, а не гадать.
    let outgoing = event;
    // Время старта уезжает вкладке вместе с ключом сессии: по нему лента
    // отличает ход, который прямо сейчас рисует поток, от записанного в
    // транскрипт раньше. Часы серверные — те же, что у транскрипта; часам
    // телефона в этом доверять нельзя.
    if (event.kind === 'session') outgoing = { ...event, startedAt: run.startedAt };
    if (event.kind === 'usage') {
      const tokens = event.input + event.output + event.cacheRead + event.cacheCreation;
      run.spentTokens += tokens;
      this.totalTokens += tokens;

      // Размер окна берём по ПОСЛЕДНЕМУ шагу, а не по максимуму: окно может и
      // уменьшиться — после автосжатия в самом CLI следующий запрос несёт уже
      // сводку, и предлагать продолжение по устаревшему пику было бы неправдой.
      // Остаток сверки с итогом прогона — не шаг: окна он не описывает.
      if (!event.remainder) {
        run.contextTokens = event.input + event.cacheRead + event.cacheCreation;
      }

      // Цена шага — чтобы разбивка по действию была видна сразу, а не после
      // перечитывания ленты из транскрипта: по одним токенам дешёвый шаг от
      // дорогого не отличить.
      if (event.model && this.estimateStepCost) {
        outgoing = { ...event, costUsd: this.estimateStepCost(event.model, event) };
      }
    }
    if (event.kind === 'done') {
      run.spentCostUsd += event.costUsd;
      this.totalCostUsd += event.costUsd;
    }

    // Два повода дёрнуть телефон посреди прогона: агент упёрся в разрешение или
    // задал вопрос. Оба означают, что работа ВСТАЛА и ждёт человека, — а
    // человек в этот момент смотрит не в панель.
    if (event.kind === 'permission') {
      this.notify?.({
        kind: 'permission',
        chatId: run.chatId,
        projectPath: run.meta.projectPath,
        toolName: event.toolName,
      });
    }
    if (event.kind === 'tool' && event.name === 'AskUserQuestion') {
      this.notify?.({ kind: 'question', chatId: run.chatId, projectPath: run.meta.projectPath });
    }

    const buffered: BufferedEvent = { seq: ++run.seq, event: outgoing };
    run.events.push(buffered);
    for (const subscriber of run.subscribers) subscriber.send(buffered);
  }

  /** Прогон завершился сам (процесс закрылся). */
  private finish(run: RegisteredRun): void {
    if (run.status !== 'running') return;
    run.status = run.errored ? 'error' : 'done';
    run.finishedAt = Date.now();

    // Продолжение в чистой сессии — ДО закрытия слушателей: событие о новом
    // разговоре должно уйти живой вкладке, а не только в буфер. Планировщик
    // чужой, поэтому его падение не имеет права утащить завершение прогона:
    // без этого исключение оставило бы слушателей открытыми навсегда.
    if (this.planHandoff) {
      try {
        const event = this.planHandoff({
          chatId: run.chatId,
          sessionId: run.sessionId,
          projectPath: run.meta.projectPath,
          text: run.text,
          ok: !run.errored,
          startedAt: run.startedAt,
          options: run.options,
          contextTokens: run.contextTokens,
        });
        if (event) this.emit(run, event);
      } catch {
        // Молча: причина отказа человеку не поможет, а прогон обязан закрыться.
      }
    }

    this.notify?.({
      kind: run.errored ? 'error' : 'done',
      chatId: run.chatId,
      projectPath: run.meta.projectPath,
    });
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
  active(): ActiveRunInfo[] {
    const now = Date.now();
    const list: ActiveRunInfo[] = [];
    for (const run of this.runs.values()) {
      const recentlyDone =
        run.status === 'done' && run.finishedAt !== undefined && now - run.finishedAt <= GRACE_MS;
      if (run.status !== 'running' && !recentlyDone) continue;
      list.push({
        chatId: run.chatId,
        sessionId: run.sessionId,
        projectPath: run.meta.projectPath,
        seq: run.seq,
        startedAt: run.startedAt,
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
