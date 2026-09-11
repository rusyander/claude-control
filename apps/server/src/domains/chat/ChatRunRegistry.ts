import type { RemoteNotifyKind } from '@agentdeck/contracts';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import type { PlatformRunConsumer } from '@agentdeck/contracts/platform-consumers';
// Только тип маршрута: про контуры, шлюз и ключи реестр по-прежнему не знает
// ничего — решение принимает домен платформы, реестр лишь передаёт его прогону.
import type { PlatformRunRoute } from '../platform/routing.ts';
import { ChatRun, type ChatEvent, type RunOptions } from './ChatRunner.ts';
import { DetachedRun, type DetachedRunDeps } from './detached-run.ts';
import { looksLikeCheck } from './lowered-journal.ts';
import { resolveCliPid, type LedgerAutoApprove, type RunLedgerEntry } from './run-ledger.ts';

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
  /**
   * Чем прогон был для контура (Т3). Нужно продолжениям и звеньям конвейера:
   * они заводятся ОТ этого прогона, и без переноса работа группы спрашивала бы
   * маршрут как «чат» — то есть меняла бы провайдера посреди цепочки.
   */
  origin?: PlatformRunConsumer;
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
  /**
   * Идёт ли прогон ещё. `done` — уже завершился, но лежит в grace-буфере:
   * клиент дотягивает из него хвост (расход, вопрос человеку), а «работает»
   * не показывает — иначе после F5 законченный разговор минуту выглядел бы
   * идущим, и его ответ печатался бы заново.
   */
  status: 'running' | 'done';
  /** Момент завершения (мс) — только у `done`. */
  finishedAt?: number;
  /**
   * Чем прогон запущен. Нужно вкладке, которая его не заводила: свою модель она
   * помнит с отправки, а подхваченный после F5 (или заведённый разделением,
   * телефоном, другой вкладкой) прогон иначе стоит в пульте агентов безымянным —
   * ровно там, где подбор модели под задачу и разводит детей по разным моделям.
   */
  model?: string;
  /**
   * Прогон усыновлён после перезапуска панели: процесс жив, потока вывода нет.
   * Вкладка по этой метке не рисует пузырь ответа — правда в транскрипте.
   */
  detached?: true;
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
  /**
   * Откуда прогон: обычный чат (`chat`, умолчание) или группа разделения
   * (`groups`). Это же — ПОТРЕБИТЕЛЬ маршрута контура (Т3): реестр знает
   * происхождение каждого прогона, и список «Где работает контур» строится по
   * нему, а не по списку пожеланий.
   */
  origin?: PlatformRunConsumer;
  /** Каталог проекта (для группировки статусов); undefined — песочница/дом. */
  projectPath?: string;
  /** Идентификатор сессии на старте (для продолжения разговора). */
  sessionId?: string;
  /**
   * Прогон уехал ступенью НИЖЕ потолка разговора (веер параллельного запуска).
   * Само присутствие поля и означает понижение; внутри — чем именно ведут, уже
   * развёрнутым именем. По этой отметке прогон попадает в журнал сдачи: без неё
   * `lowered` умирал в маршруте, и спросить «окупается ли понижение» было не у
   * кого.
   */
  lowered?: {
    model: string;
    effort: string;
    /**
     * Класс работы, из-за которого ступень и понизили. Есть у детей разделения
     * и у звена правок; у ручного веера его нет вовсе — там ступень выбрал
     * человек, и рода работы никто не называл.
     */
    kind?: string;
  };
}

/**
 * Минимум, что реестру нужно от прогона: запуститься с колбэком событий и уметь
 * остановиться. `ChatRun` этому соответствует; интерфейс нужен, чтобы в тестах
 * подставлять управляемый фейк вместо запуска настоящего CLI.
 */
export interface RunLike {
  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void>;
  stop(): void;
  /** PID процесса, известный сразу после `start()`; нет — прогон не усыновить. */
  readonly pid?: number | undefined;
}

type RunFactory = () => RunLike;

type RunStatus = 'running' | 'done' | 'error' | 'stopped';

/**
 * С какого номера нумерует события усыновлённый прогон. Вкладка, открытая на
 * разговоре в момент перезапуска, переподключается с `from=<последний seq>`
 * ПРЕЖНЕЙ жизни сервера, а буфер усыновлённого начинается заново — с нуля
 * сессия и заметка о подхвате оказались бы «уже виденными» и не дошли бы до
 * ленты (09.09.2026: строка «связь потеряна» вместо заметки, карточка прав
 * дошла лишь потому, что пришла живым событием). Номер выше любого
 * достижимого живым прогоном закрывает вопрос: всё усыновлённое для такой
 * вкладки — новое, а для открывшейся заново это просто число.
 */
export const ADOPTED_SEQ_BASE = 1_000_000_000;

/** Вызовы, которыми агент правит код: первый из них — начало работы по задаче. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface RegisteredRun {
  chatId: string;
  run: RunLike;
  /**
   * Pid самого CLI, когда `run.pid` — лишь оболочка над ним (Windows): в журнал
   * идёт он, потому что оболочку перезапуск сервера забирает с собой.
   */
  cliPid?: number;
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
  /** Момент первой правки кода (мс) — слушателю сообщается один раз. */
  firstEditAt?: number;
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
  /**
   * Замеченные команды проверок проекта — только у понижённого прогона, которому
   * дописана планка сдачи. Копим ВО ВРЕМЯ прогона: после завершения буфер живёт
   * минуту и уходит, а журналу нужен итог.
   */
  checks: string[];
  /**
   * Усыновлён после перезапуска панели (см. `adopt`): процесс жив, но stdout
   * умер вместе с прежним сервером. Текста ответа у такого прогона нет, поэтому
   * планировщик продолжений и журнал сдачи его не видят.
   */
  detached?: boolean;
}

/** Куда реестр пишет идущие прогоны, чтобы пережить перезапуск (см. `run-ledger.ts`). */
/** Снимок параметров прогона для тех, кто перезапускает его снаружи (пауза дерева). */
export interface RunSnapshot {
  key: string;
  status: RunStatus;
  options: RunOptions;
  meta: RunMeta;
  sessionId?: string;
}

export interface RunLedgerSink {
  upsert(entry: RunLedgerEntry): void;
  remove(key: string): void;
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

/**
 * Сколько выбывших прогонов помним по их второму написанию ключа. Строка на
 * прогон, за сеанс сервера их сотни — предел нужен от бесконечного роста.
 */
const MAX_RETIRED = 200;

/**
 * Сколько замеченных проверок держим на прогон и какой длины хвост команды
 * пишем. Журналу нужен факт «проверки видели» и повод их узнать, а не полная
 * стенограмма: агент, гоняющий тесты в цикле, иначе раздул бы файл журнала.
 */
const MAX_CHECKS = 12;
const CHECK_TEXT_MAX = 200;

export class ChatRunRegistry {
  private runs = new Map<string, RegisteredRun>();
  private readonly createRun: RunFactory;

  /**
   * `sessionId` → ключ, под которым прогон был заведён. Заполняется, когда
   * прогон уходит из реестра: сам он больше не нужен, а связь двух его написаний
   * спрашивают и после (см. `resolveKey`).
   */
  private readonly retired = new Map<string, string>();

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
   * Куда записать завершившийся ПОНИЖЕННЫЙ прогон. Снаружи по той же причине,
   * что и остальные крючки: файл журнала живёт в каталоге данных панели, а
   * реестр про каталоги не знает. Не задан — журнал не ведётся, и прогоны от
   * этого не меняются.
   */
  private journal?: (record: LoweredRunRecord) => void;

  setLoweredJournal(write: (record: LoweredRunRecord) => void): void {
    this.journal = write;
  }

  /**
   * Прогон назвал свой настоящий `sessionId`. Ставится снаружи по той же
   * причине, что и остальные крючки: реестр знает про прогоны, а что делать с
   * этим знанием — дело домена. Сейчас слушатель ровно один: разделение задач
   * переносит на настоящий ключ связь «родитель → потомок», иначе дерево чатов
   * распадалось бы ровно в тот момент, когда временный ключ сменяется живым.
   */
  private onSession?: (chatId: string, sessionId: string) => void;

  /**
   * Маршрут контура: по происхождению прогона — переменные его окружения (Т3)
   * и системный промпт контура, если тот включён (Т5.4а).
   *
   * Подаётся снаружи, как и оценка стоимости: реестр знает, ОТКУДА прогон, но
   * про контуры, шлюз и ключи не знает ничего и знать не должен. Спрашивается
   * на КАЖДОМ старте — снятая галочка обязана действовать со следующего
   * запуска, а не с перезапуска панели.
   */
  setPlatformRouting(resolve: (origin: PlatformRunConsumer) => PlatformRunRoute): void {
    this.platformRouting = resolve;
  }

  private platformRouting?: (origin: PlatformRunConsumer) => PlatformRunRoute;

  setSessionListener(listener: (chatId: string, sessionId: string) => void): void {
    this.onSession = listener;
  }

  /**
   * Первая правка кода в прогоне. Слушатель — связь «родитель → потомок»: по
   * разнице с моментом заведения ребёнка видно, сколько агент потратил на
   * обживание копии до работы (Т9). Ключей два по той же причине, что и у
   * связи: временный и настоящий, и который из них знает хранилище — ему виднее.
   */
  private onFirstEdit?: (keys: readonly string[], at: string) => void;

  setFirstEditListener(listener: (keys: readonly string[], at: string) => void): void {
    this.onFirstEdit = listener;
  }

  /**
   * Журнал идущих прогонов на диске — чтобы после перезапуска панели живые
   * процессы CLI нашлись и были усыновлены (`adopt`), а не встречали пустой
   * реестр отказом «Разговор не найден» на каждый запрос прав. Снаружи по той
   * же причине, что и остальные крючки: каталог данных знает bootstrap.
   *
   * Второй колбэк — снимок тумблеров автоподтверждения: они живут в
   * `ChatSession`, а усыновлённый прогон без них спрашивал бы человека о каждом
   * вызове. Не задан журнал — прогоны не переживают перезапуск, как раньше.
   */
  private ledger?: RunLedgerSink;
  private snapshotAutoApprove?: (key: string) => LedgerAutoApprove | undefined;
  private resolvePid: (wrapperPid: number) => Promise<number> = resolveCliPid;

  setLedger(
    ledger: RunLedgerSink,
    snapshotAutoApprove?: (key: string) => LedgerAutoApprove | undefined,
    resolvePid: (wrapperPid: number) => Promise<number> = resolveCliPid,
  ): void {
    this.ledger = ledger;
    this.snapshotAutoApprove = snapshotAutoApprove;
    this.resolvePid = resolvePid;
  }

  /**
   * Переписать запись прогона в журнале — по старту, по смене ключа и по щелчку
   * тумблера на ходу (`ChatSession` зовёт это сам). Не идущий прогон в журнале
   * не нужен: усыновлять там нечего.
   */
  persist(chatId: string): void {
    if (!this.ledger) return;
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run || run.status !== 'running') return;
    const pid = run.cliPid ?? run.run.pid;
    const autoApprove = this.snapshotAutoApprove?.(key);
    this.ledger.upsert({
      key,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.meta.projectPath ? { projectPath: run.meta.projectPath } : {}),
      cwd: run.options.cwd,
      ...(pid !== undefined ? { pid } : {}),
      startedAt: run.startedAt,
      ...(run.options.model ? { model: run.options.model } : {}),
      ...(run.options.effort ? { effort: run.options.effort } : {}),
      ...(run.meta.lowered ? { lowered: run.meta.lowered } : {}),
      ...(autoApprove ? { autoApprove } : {}),
    });
  }

  /**
   * Усыновить прогон из журнала после перезапуска панели: процесс жив, трубы к
   * нему нет. Прогон встаёт в реестр под прежним ключом — брокер прав находит
   * его по `PERM_RUN_ID` и рисует карточку в его чате; «Остановить» валит дерево
   * по pid; конец определяется по жизни pid (`DetachedRun`). Первым в поток
   * уходит событие сессии: по нему вкладка узнаёт ключ и время старта, а
   * заметка о подхвате — следом, из самого прогона. false — усыновлять нечего:
   * pid не записан или под этим ключом уже что-то идёт.
   */
  adopt(entry: RunLedgerEntry, deps: DetachedRunDeps = {}): boolean {
    if (entry.pid === undefined || this.runs.has(entry.key)) return false;
    const run = new DetachedRun(entry.pid, entry.startedAt, deps);
    const registered: RegisteredRun = {
      chatId: entry.key,
      run,
      meta: {
        ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.lowered ? { lowered: entry.lowered } : {}),
      },
      options: {
        prompt: '',
        cwd: entry.cwd,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.effort ? { effort: entry.effort } : {}),
      },
      startedAt: entry.startedAt,
      text: '',
      events: [],
      seq: ADOPTED_SEQ_BASE,
      status: 'running',
      errored: false,
      sessionId: entry.sessionId,
      subscribers: new Set(),
      spentCostUsd: 0,
      spentTokens: 0,
      contextTokens: 0,
      checks: [],
      detached: true,
    };
    this.runs.set(entry.key, registered);
    if (entry.sessionId) {
      this.emit(registered, {
        kind: 'session',
        sessionId: entry.sessionId,
        model: entry.model ?? '',
        tools: 0,
      });
    }
    void run
      .start(registered.options, (event) => this.emit(registered, event))
      .then(() => this.finish(registered))
      .catch(() => this.finish(registered));
    return true;
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
   * совпадение по самому sessionId (в обе стороны) → память о выбывших
   * прогонах. Ничего не нашли — ключом остаётся chatId (новый разговор).
   *
   * Последний шаг нужен потому, что завершённый прогон живёт в реестре ровно
   * `GRACE_MS`, а вопросы о нём приходят и позже: разделение стартует тогда,
   * когда человек прочитал карточку. Без памяти о синониме тумблеры родителя,
   * взведённые под `new-…`, переставали находиться по sessionId — и дети веера
   * заводились без автоподтверждения.
   */
  resolveKey(chatId: string, sessionId?: string): string {
    if (this.runs.has(chatId)) return chatId;
    for (const [key, run] of this.runs) if (run.sessionId === chatId) return key;
    if (sessionId) {
      if (this.runs.has(sessionId)) return sessionId;
      for (const [key, run] of this.runs) if (run.sessionId === sessionId) return key;
    }
    return (
      this.retired.get(chatId) ?? (sessionId ? this.retired.get(sessionId) : undefined) ?? chatId
    );
  }

  /** Идёт ли сейчас прогон этого разговора (в любом из написаний ключа). */
  /**
   * Чем прогон был заведён — его параметры, мета и названная им сессия. Нужно
   * паузе дерева: остановленный прогон продолжают в ТОЙ ЖЕ сессии и с теми же
   * правами, а параметры до этого жили только внутри реестра. Копия, не
   * внутренний объект.
   */
  describe(chatId: string): RunSnapshot | undefined {
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run) return undefined;
    return {
      key,
      status: run.status,
      options: { ...run.options },
      meta: { ...run.meta },
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    };
  }

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
    // Маршрут решается ЗДЕСЬ, на каждом старте: продолжение остановленного
    // прогона приходит со СТАРЫМИ параметрами (пауза дерева, продолжение в
    // чистой сессии), и адрес контура, оставшийся в них с прошлой жизни,
    // пережил бы снятую галочку. Пустой объект — законный ответ «не через
    // контур», и он затирает прежний.
    const route = this.platformRouting?.(meta.origin ?? 'chat') ?? { env: {} };
    const routed: RunOptions = {
      ...options,
      platformEnv: route.env,
      // Промпт контура ставится и СНИМАЕТСЯ здесь же: прогон, продолженный
      // после выключенной галочки, обязан вернуться к промпту CLI.
      platformSystemPrompt: route.systemPrompt ?? '',
    };
    const registered: RegisteredRun = {
      chatId,
      run,
      meta,
      options: routed,
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
      checks: [],
    };
    this.runs.set(chatId, registered);

    void run
      .start(routed, (event) => this.emit(registered, event))
      .then(() => this.finish(registered))
      .catch((error) => {
        this.emit(registered, {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        this.finish(registered);
      });
    // В журнал — ПОСЛЕ старта: pid появляется в момент `spawn`, а тот идёт до
    // первого `await` внутри `start`, так что здесь он уже известен.
    this.persist(chatId);
    // Первая запись — с номером обёртки, чтобы окно без записи было нулевым;
    // как только под ней найден сам CLI, запись переписывается его номером.
    const wrapperPid = run.pid;
    if (this.ledger && wrapperPid !== undefined) {
      void this.resolvePid(wrapperPid)
        .then((cliPid) => {
          if (cliPid === wrapperPid || registered.status !== 'running') return;
          registered.cliPid = cliPid;
          this.persist(registered.chatId);
        })
        .catch(() => {});
    }

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
    // Ключ разговора стал настоящим — сообщаем ровно один раз, на смене. Журнал
    // на диске тоже узнаёт второе написание: после перезапуска по нему находят
    // прогон вкладки, знающие разговор по sessionId.
    if (run.sessionId && run.sessionId !== knownSession) {
      this.onSession?.(run.chatId, run.sessionId);
      this.persist(run.chatId);
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
    if (event.kind === 'tool' && !run.firstEditAt && EDIT_TOOLS.has(event.name)) {
      run.firstEditAt = Date.now();
      const keys = run.sessionId ? [run.chatId, run.sessionId] : [run.chatId];
      this.onFirstEdit?.(keys, new Date(run.firstEditAt).toISOString());
    }

    // Планка сдачи требует прогнать проверки проекта — и до сих пор это была
    // просьба, которую никто не сверял. Смотрим, что понижённый прогон
    // ЗАПУСКАЛ: видно только `Bash`, поэтому пустой список означает «панель не
    // видела», а не «агент не делал» (см. `looksLikeCheck`). Копим только у
    // понижённых: у остальных планки нет и сверять нечего.
    if (run.meta.lowered && event.kind === 'tool' && event.name === 'Bash') {
      const command = (event.input as { command?: unknown } | null)?.command;
      if (
        typeof command === 'string' &&
        looksLikeCheck(command) &&
        run.checks.length < MAX_CHECKS
      ) {
        run.checks.push(command.slice(0, CHECK_TEXT_MAX));
      }
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
    // Процесса больше нет — усыновлять после перезапуска нечего.
    this.ledger?.remove(run.chatId);

    // Продолжение в чистой сессии — ДО закрытия слушателей: событие о новом
    // разговоре должно уйти живой вкладке, а не только в буфер. Планировщик
    // чужой, поэтому его падение не имеет права утащить завершение прогона:
    // без этого исключение оставило бы слушателей открытыми навсегда.
    //
    // Усыновлённый прогон сюда не ходит: текста ответа у него нет (труба умерла
    // с прежним сервером), и планировщик читал бы пустоту — ни блока
    // продолжения, ни ревью по нему завести нельзя честно. Журнал сдачи — тоже:
    // проверок панель не видела не потому, что их не было.
    if (this.planHandoff && !run.detached) {
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
          ...(run.meta.origin ? { origin: run.meta.origin } : {}),
        });
        if (event) this.emit(run, event);
      } catch {
        // Молча: причина отказа человеку не поможет, а прогон обязан закрыться.
      }
    }

    // Понижённый прогон закончился — записываем, чем его вели и видела ли
    // панель проверки. Пишет чужой код (файл в каталоге данных), поэтому его
    // падение не имеет права утащить завершение прогона: слушатели ниже обязаны
    // закрыться в любом случае.
    if (run.meta.lowered && this.journal && !run.detached) {
      try {
        this.journal({
          chatId: run.chatId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          ...(run.meta.projectPath ? { projectPath: run.meta.projectPath } : {}),
          model: run.meta.lowered.model,
          effort: run.meta.lowered.effort,
          ...(run.meta.lowered.kind ? { kind: run.meta.lowered.kind } : {}),
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ok: !run.errored,
          checks: run.checks,
          // Сколько окна съел прогон. Ради этого числа журнал и заводился:
          // «окупается ли понижение» — вопрос про расход окна, а не про то,
          // сколько раз панель понизила.
          tokens: run.spentTokens,
        });
      } catch {
        // Молча: журнал — наблюдение, а не часть работы прогона.
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
        status: recentlyDone ? 'done' : 'running',
        finishedAt: run.finishedAt,
        // Пусто значит «как решит CLI» — тогда имя приедет событием сессии.
        ...(run.options.model ? { model: run.options.model } : {}),
        ...(run.detached ? { detached: true as const } : {}),
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
    // Остановленный по кнопке сюда приходит, минуя `finish`, — журнал чистим и здесь.
    this.ledger?.remove(chatId);
    // Прогон ушёл, но его два написания спрашивать не перестанут: карточка
    // разделения знает разговор по sessionId, а тумблеры и висящие состояния
    // заведены под тем ключом, с которым прогон стартовал. Помним связь после
    // выбывания — она весит одну строку и не воскрешает сам прогон.
    if (run.sessionId && run.sessionId !== chatId) {
      this.retired.set(run.sessionId, chatId);
      for (const key of this.retired.keys()) {
        if (this.retired.size <= MAX_RETIRED) break;
        this.retired.delete(key);
      }
    }
  }
}
