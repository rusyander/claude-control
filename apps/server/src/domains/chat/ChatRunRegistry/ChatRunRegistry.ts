import { receivedInputOf, type RunOptions } from '../run-options/run-options.ts';
import type { ChatEvent } from '../chat-events.ts';
import type { RunNotice } from '../../notify/run-notice.types.ts';
// Прежний адрес типа — для тех, кто ещё не перешёл на `notify/run-notice.types.ts`.
export type { RunNotice };
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import type { LimitSample } from '@agentdeck/contracts/limit-share';
import type { PlatformRunConsumer } from '@agentdeck/contracts/platform-consumers';
// Только тип маршрута: про контуры, шлюз и ключи реестр по-прежнему не знает
// ничего — решение принимает домен платформы, реестр лишь передаёт его прогону.
import type { PlatformRunRoute } from '../../platform/routing/routing.ts';
import { claudeModelHasAutoMode } from '../../../providers/claude-auto-mode.ts';
import type { RunInputRecord } from '@agentdeck/contracts/run-input';
import { DetachedRun, type DetachedRunDeps } from '../detached-run/detached-run.ts';
import { withoutChildrenBrief } from '../children-brief/children-brief.ts';
import { withoutMcp, type GroupRunProfile } from '../group-profile/group-profile.ts';
import { capKitToRoute, capProfileToRoute } from './route-caps.ts';
import {
  isCliCommand,
  SessionWorkspaceNotes,
  withWorkspaceUpdate,
  type NoteTurn,
  type SessionNote,
} from '../workspace-note/workspace-note.ts';
import type { ClosingTurn } from '../ChatHistory/ChatHistory.ts';
import { looksLikeCheck } from '../lowered-journal/lowered-journal.ts';
import { withLimitSample, type LimitRunRecord } from '../limit-journal/limit-journal.ts';
import { normalizePath } from '../../project-runner/targets.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  resolveCliPid,
  type LedgerAutoApprove,
  type RunLedgerEntry,
} from '../run-ledger/run-ledger.ts';
import type {
  LatestRun,
  RunMeta,
  RunWatchFeed,
  RunWatchListener,
} from './ChatRunRegistry.types.ts';
import { endRelayInput, ledgerLaunchOf, ledgerRunMeta, ledgerRunOptions } from '../run-reattach.ts';
import { confirmedPicks } from '../auto-pick/auto-pick.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { withProcessSnapshot } from '../../../lib/process-tree/process-tree.ts';
import { localLayerCarry, withoutProjectSource } from '../../local-layer/local-layer.ts';
import type { LayerRunExtras } from '../../local-layer/local-layer.types.ts';
import { firstQuestionOf, questionOptionsOf } from '../../notify/telegram-text.ts';

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
  /**
   * Итог хода — текст после последнего вызова инструмента, без хода рассуждений
   * между вызовами. Его, а не хвост всего текста, читает следующее звено группы:
   * хвост в 24k нёс пересказ по ходу работы и блоки сит (группа 1, 25.10).
   */
  answer?: string;
  /**
   * Итог звена, когда хук Stop отбивал конец хода: ответ до ПЕРВОГО замечания хука.
   * Ответ на замечание («страницы трогать не нужно…») — хвост, а не итог: следующее
   * звено получало его вместо сводки и восстанавливало её по git (g5 25.10, P1).
   */
  summary?: string;
  /** Прогон закончился без ошибки (лимит и остановка тоже приходят ошибкой). */
  ok: boolean;
  startedAt: number;
  options: RunOptions;
  /** Окно контекста на последнем шаге; 0 — расход не приходил (чужой CLI, ошибка). */
  contextTokens: number;
  /**
   * Ход кончился, а фоновая команда агента ещё идёт (живая сессия держит её):
   * работа не закончена, группа разделения ждёт фон, а не «готово» (Д3).
   */
  background?: boolean;
  /**
   * Ход звал `AskUserQuestion`: вопрос висит карточкой, агент по `QUESTION_DENIED`
   * закончил ход ожиданием ответа — и текст при этом не обязан кончаться «?».
   * Для группы это «ждёт человека», а не «готово» (Д3/Д16, живой прогон 23.09).
   */
  asked?: boolean;
  /**
   * Чем прогон был для контура (Т3). Нужно продолжениям и звеньям конвейера:
   * они заводятся ОТ этого прогона, и без переноса работа группы спрашивала бы
   * маршрут как «чат» — то есть меняла бы провайдера посреди цепочки.
   */
  origin?: PlatformRunConsumer;
  /**
   * Модель прогона подставил маршрут контура: в `options` модель маршрута и
   * пустая глубина, а не то, что просили.
   */
  routed?: true;
  /**
   * Имена, которые переводит карта соответствия контура этого прогона
   * (`PlatformRunRoute.modelMapKeys`): звено доставки через контур идёт на
   * «sonnet», только когда у контура есть такая строка (n6).
   */
  routedMap?: readonly string[];
  /** Прогон шёл на локальной модели (`RunMeta.local`). */
  local?: true;
  /** Сколько инструментов отработало за ход: у продолжения — «успело поработать». */
  toolResults?: number;
  /** Последняя ошибка хода — по ней надзор решает, временный ли сбой (Д10). */
  error?: string;
  /** Последнее событие лимита: `rejected` с `resetsAt` — повтор в момент сброса (Д10). */
  limit?: { resetsAt: number; status: string };
  /**
   * Надзор уже назначил повтор этого хода (Д10): группа не `failed`, а ждёт
   * повтора. Ставит обёртка планировщика, не реестр.
   */
  retry?: { attempt: number; at: number; limit?: true } | { exhausted: number };
  /**
   * Усыновлённый процесс умер, не дописав ход: закрывающего ответа в транскрипте
   * нет. Это обрыв, а не итог — группа разделения прервана (WP1c).
   */
  interrupted?: true;
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
   * Глубина, на которой прогон запущен. Чат, заведённый сервером (вопрос о ходе
   * групп, 5.1), до конца первого хода в списке не значится — шапка его прогона
   * иначе показала бы глубину из настроек вместо настоящей.
   */
  effort?: string;
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
  /**
   * Прогон завершился — закрыть поток слушателя. `stopped` — его остановили
   * (кнопка, пауза, отмена плана), а не ход кончился сам.
   */
  close: (reason?: 'stopped') => void;
}

export type { RunMeta };

/**
 * Решение о продолжении (`setContinuationPolicy`): нет ответа — старт как
 * просили; есть — с этими параметрами и, если надо, заметкой человеку.
 */
export type ContinuationPolicy = (
  keys: readonly string[],
  options: RunOptions,
  meta: RunMeta,
) => { options: RunOptions; meta: RunMeta; notice?: ChatEvent } | undefined;

/**
 * Минимум, что реестру нужно от прогона: запуститься с колбэком событий и уметь
 * остановиться. `ChatRun` этому соответствует; интерфейс нужен, чтобы в тестах
 * подставлять управляемый фейк вместо запуска настоящего CLI.
 */
export interface RunLike {
  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void>;
  /**
   * Остановить процесс. `'unconfirmed'` — процесс жив и не снят: номер нечем
   * проверить (F-145); прогон тогда остаётся идущим.
   */
  stop(): 'unconfirmed' | void;
  /** PID процесса, известный сразу после `start()`; нет — прогон не усыновить. */
  readonly pid?: number | undefined;
  /** Выход сервера: процесс, способный его пережить, отпустить живым (см. `detachAll`). */
  detach?(): void;
  /** Процесс ушёл сам, держа фоновые задачи агента, — обрыв, а не провал (W3-4c). */
  readonly lostBackground?: boolean;
  /** Сообщение человека посреди хода — агенту сразу; `false` — не вышло. */
  steer?(prompt: string): boolean;
}

type RunFactory = () => RunLike;

/** Реестр без фабрики: старт прогона — отказ с причиной (поток получает ошибку прогона). */
const noRunFactory: RunFactory = () => ({
  start: () => Promise.reject(new Error('no run factory: chat runs go through the core')),
  stop: () => undefined,
});

type RunStatus = 'running' | 'done' | 'error' | 'stopped';

/**
 * Итог «Остановить»: `absent` — прогона нет; `unconfirmed` — процесс жив и не
 * снят (номер нечем проверить, F-145), прогон и запись журнала оставлены.
 */
export type StopOutcome = 'stopped' | 'absent' | 'unconfirmed';

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
  /**
   * Старт, который правило остывшей сессии заменило новым разговором: с ним
   * человек возвращает ход в старую сессию (`keepColdSession`, R5 ревью П1).
   */
  coldOrigin?: { options: RunOptions; meta: RunMeta };
  /** Старт был пробуждением — ход начал сам CLI. Отметка этого старта, в `options` её нет. */
  woken?: true;
  /** Модель старта подставил маршрут контура — см. `RunFinished.routed`. */
  routed?: true;
  /** Карта соответствия контура этого старта — см. `RunFinished.routedMap`. */
  routedMap?: readonly string[];
  /** Момент старта (мс) — по нему видно, обновлён ли файл-опора этим прогоном. */
  startedAt: number;
  /** Хвост ответа агента: в нём ищется блок предложения продолжить. */
  text: string;
  /** Текст после последнего вызова инструмента — итог хода (см. `RunFinished.answer`). */
  answer?: string;
  /**
   * Итог хода до ПЕРВОГО замечания хука Stop (`RunFinished.summary`): `undefined` —
   * хук ход не отбивал. Строка (и пустая) — отбивал, дальше замечания не трогают.
   */
  summary?: string;
  events: BufferedEvent[];
  /** Размер буфера в байтах (JSON кадров) — для предела `MAX_BUFFERED_BYTES`. */
  eventBytes: number;
  /** Номер последнего сброшенного кадра; 0 — ничего не сбрасывалось. */
  trimmedSeq: number;
  seq: number;
  status: RunStatus;
  errored: boolean;
  /** Текст последней ошибки и последний лимит хода — надзору повторов (Д10). */
  lastError?: string;
  limit?: { resetsAt: number; status: string };
  /** Различные замеры загрузки окон подписки (`withLimitSample`) — журналу доли лимита. */
  limitSamples?: LimitSample[];
  /** Когда запись прогона в журнале лимита последний раз обновлялась посреди него. */
  limitJournalAt?: number;
  /** Ход звал `AskUserQuestion` — см. `RunFinished.asked`. */
  asked?: boolean;
  /** Тела вызовов `AskUserQuestion` по id: по ним автовыбор узнаёт `critical`. */
  askInputs?: Map<string, unknown>;
  /** Вызовы, закрытые автовыбором: вопрос не висит, ждать человека нечего. */
  autoPicked?: Set<string>;
  /**
   * Был вопрос без id: автовыбор узнаётся по id вызова, такой ему не закрыть —
   * признак `asked` пересчётом по `askInputs` не снимается.
   */
  askedUnkeyed?: boolean;
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
   * Шаги с моделью, у которой цены нет (локальная Qwen под переключателем
   * Claude), и с ценой. Только безценовые — итог хода от CLI выдуман: он
   * считает чужую модель по тарифу Claude (живой прогон 11.10: $0.19).
   */
  unpricedSteps?: number;
  pricedSteps?: number;
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
  /** Сколько инструментов отработало за прогон — мера «продолжение сделало работу» (L4c, F5). */
  toolResults?: number;
  /**
   * Усыновлён после перезапуска панели (см. `adopt`): процесс жив, но stdout
   * умер вместе с прежним сервером. Текст ответа у такого прогона копится не в
   * потоке, а в транскрипте — на конце его дочитывает `closingTurnOf`; журнал
   * сдачи усыновлённого по-прежнему не видит (проверок панель не наблюдала).
   */
  detached?: boolean;
  /** Все процессы записи журнала прежней версии — посредник, оболочка, CLI (журнал 84). */
  pids?: number[];
  /** Фон, записанный в журнал до перезапуска: процесс умер — умер и он (журнал 64). */
  ledgerBackground?: number;
  /** Строка о тестах этого хода (E6): запоминается за сессией, когда та названа. */
  workspace?: SessionNote;
}

/** Снимок параметров прогона для тех, кто перезапускает его снаружи (пауза дерева). */
export interface RunSnapshot {
  key: string;
  status: RunStatus;
  options: RunOptions;
  meta: RunMeta;
  sessionId?: string;
  /** Прогон заведён под ход, начатый самим CLI (`wake`); сам флаг из `options` снят. */
  woken?: true;
}

/** Куда реестр пишет идущие прогоны, чтобы пережить перезапуск (см. `run-ledger.ts`). */
export interface RunLedgerSink {
  /** Перечитать журнал: поздний подхват ищет в нём запись по ключу прогона. */
  read(): RunLedgerEntry[];
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
 * Как часто запись прогона в журнале лимита обновляется посреди него: файл
 * читается и переписывается целиком, а событие лимита приходит на каждом ходе.
 */
const LIMIT_JOURNAL_EVERY_MS = 5 * 60_000;

/**
 * Сколько последних символов ответа держим ради разбора блока продолжения.
 * Хвоста хватает: блок агент выводит в самом конце хода, а хранить целиком
 * ответы всех прогонов сервера значило бы держать в памяти мегабайты текста,
 * который уже лежит в транскрипте.
 */
const TEXT_TAIL = 32_768;

/**
 * Буфер кадров прогона нужен одному: переподключившийся клиент догоняет по нему хвост.
 * Ночной прогон на локальной модели льёт кадры часами (каждый вывод инструмента, каждый
 * кусок ответа), а буфер жил до конца прогона плюс минуту — память панели росла без предела.
 * Держим последние кадры в пределах числа и объёма; старше — только в транскрипте сессии,
 * который клиент перечитывает по окончании хода. Последний кадр остаётся всегда.
 */
export const MAX_BUFFERED_EVENTS = 4_000;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
  /**
   * Ключ, параметры и мета последнего хода разговора по `sessionId`: прогон к
   * этому времени давно вышел из буфера, а ответ из Telegram (`latestRunOf`)
   * продолжает разговор с его моделью, усилием и режимом.
   */
  private readonly wakeable = new Map<
    string,
    { chatId: string; options: RunOptions; meta: RunMeta }
  >();
  private localOf?: (options: RunOptions, meta: RunMeta) => boolean;

  /** Как узнать прогон на локальной модели по его опциям: ответ уходит в метку `RunMeta.local` и в журнал. */
  setLocalClassifier(classify: (options: RunOptions, meta: RunMeta) => boolean): void {
    this.localOf = classify;
  }

  /** Идёт ли хоть один прогон, подходящий под условие (по опциям и метке запуска). */
  anyRunning(match: (run: { options: RunOptions; meta: RunMeta }) => boolean): boolean {
    for (const run of this.runs.values()) {
      if (run.status === 'running' && match({ options: run.options, meta: run.meta })) return true;
    }
    return false;
  }

  /** Накопленный за сеанс сервера расход — переживает перезагрузку вкладки. */
  private totalCostUsd = 0;
  private totalTokens = 0;

  /**
   * Оценка стоимости шага. Ставится снаружи (маршрутами): тарифы живут в кэше
   * прайса и в настройках пользователя, а реестр про них ничего не знает и
   * знать не должен. Не задана — цена шага просто не показывается.
   */
  private estimateStepCost?: (model: string, tokens: StepTokens) => number | undefined;

  setCostEstimator(estimate: (model: string, tokens: StepTokens) => number | undefined): void {
    this.estimateStepCost = estimate;
  }

  /**
   * Куда сдать время генерации хода (id сообщения, мс, модель). Ставится снаружи:
   * журнал живёт в каталоге данных панели, а реестр путей не знает. Не задано —
   * скорость видна только пока ответ идёт.
   */
  private noteGenTime?: (messageId: string, genMs: number, model: string | undefined) => void;

  setGenTimeSink(
    note: (messageId: string, genMs: number, model: string | undefined) => void,
  ): void {
    this.noteGenTime = note;
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
   * Куда записать завершившийся прогон для доли лимита подписки
   * (`limit-journal.ts`): интервал, токены и замеры окон. Любой прогон с
   * токенами или замером, не только звенья групп, — загрузка окна общая.
   */
  private limitJournal?: (record: LimitRunRecord) => void;

  setLimitJournal(write: (record: LimitRunRecord) => void): void {
    this.limitJournal = write;
  }

  /**
   * Записать прогон в журнал лимита — посреди него (новый замер) и на конце.
   * Ключ записи один на прогон, журнал заменяет прежнюю: конец не плодит вторую.
   */
  private writeLimitJournal(run: RegisteredRun, endedAt: number, open = false): void {
    const samples = run.limitSamples ?? [];
    if (!this.limitJournal || run.detached || (run.spentTokens <= 0 && samples.length === 0)) {
      return;
    }
    try {
      this.limitJournal({
        id: `${run.chatId}:${run.startedAt}`,
        chatId: run.chatId,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        startedAt: run.startedAt,
        endedAt,
        tokens: run.spentTokens,
        samples,
        ...(open ? { open: true as const } : {}),
      });
    } catch {
      // Молча, как журнал понижений: наблюдение не держит прогон.
    }
  }

  /** Идущие прогоны с замерами, ещё не записанными в журнал лимита, — записать сейчас. */
  flushLimitJournal(now = Date.now()): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || !run.limitSamples?.length) continue;
      run.limitJournalAt = now;
      this.writeLimitJournal(run, now, true);
    }
  }

  /**
   * «Что получил агент» (U8): вход каждого стартовавшего прогона — после
   * маршрута контура, сводки детей и всех дописок, то есть ровно то, что уедет
   * CLI. Куда писать, знает bootstrap, как и для журнала понижений.
   */
  setInputJournal(write: (keys: readonly string[], record: RunInputRecord) => void): void {
    this.inputJournal = write;
  }

  private inputJournal?: (keys: readonly string[], record: RunInputRecord) => void;

  /**
   * Прогон назвал свой настоящий `sessionId`. Ставится снаружи по той же
   * причине, что и остальные крючки: реестр знает про прогоны, а что делать с
   * этим знанием — дело домена. Сейчас слушатель ровно один: разделение задач
   * переносит на настоящий ключ связь «родитель → потомок», иначе дерево чатов
   * распадалось бы ровно в тот момент, когда временный ключ сменяется живым.
   */
  private onSession?: (chatId: string, sessionId: string, from?: string) => void;

  /**
   * Маршрут контура: по происхождению прогона — переменные его окружения (Т3),
   * системный промпт контура, если тот включён (Т5.4а), и модель с усилием,
   * которыми прогон пойдёт на самом деле (Т6). Имя, названное прогоном,
   * передаётся вопросом, а не решением: перевести его в модель контура — дело
   * домена, у реестра нет ни каталога, ни карты соответствия.
   *
   * Подаётся снаружи, как и оценка стоимости: реестр знает, ОТКУДА прогон, но
   * про контуры, шлюз и ключи не знает ничего и знать не должен. Спрашивается
   * на КАЖДОМ старте — снятая галочка обязана действовать со следующего
   * запуска, а не с перезапуска панели.
   */
  setPlatformRouting(
    resolve: (origin: PlatformRunConsumer, asked: string) => PlatformRunRoute,
  ): void {
    this.platformRouting = resolve;
  }

  private platformRouting?: (origin: PlatformRunConsumer, asked: string) => PlatformRunRoute;

  setSessionListener(listener: (chatId: string, sessionId: string, from?: string) => void): void {
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
   * Прогон разговора стартовал — любой: сообщение человека, звено конвейера,
   * повтор, ход, начатый самим CLI. Слушатель — конвейер разделения: группа,
   * чей ход кончился паузой или итогом, снова «работает» (Д3).
   */
  private onRunStart?: (keys: readonly string[]) => void;

  setStartListener(listener: (keys: readonly string[]) => void): void {
    this.onRunStart = listener;
  }

  /** Сторож групп (`RunWatchFeed`): только наблюдает, его сбой прогон не трогает. */
  private watch?: RunWatchListener;

  setWatchListener(listener: RunWatchListener): void {
    this.watch = listener;
  }

  private feedWatch(chatId: string, feed: RunWatchFeed): void {
    try {
      this.watch?.(chatId, feed);
    } catch {
      // Слушатель чужой: поток прогона обязан идти дальше.
    }
  }

  /**
   * Человек нажал «Стоп» в чате (журнал 89c). Слушатель — конвейер разделения:
   * остановленная группа встаёт на паузу, а не «сбоем», и место в очереди
   * отдаёт следующей. Остановка панелью (выход, замена прогона) сюда не идёт.
   */
  private onHumanStop?: (keys: readonly string[]) => void;

  setHumanStopListener(listener: (keys: readonly string[]) => void): void {
    this.onHumanStop = listener;
  }

  /**
   * Агент встал на человеке — вызов `AskUserQuestion`, запрос прав — или запрос
   * прав решён. Слушатель — серверная запись ждущих вопросов (WP9c): поток
   * видит только вкладка, которая к нему подключена, а у группы, запущенной
   * конвейером, такой вкладки нет.
   */
  private onAsk?: (keys: readonly string[], event: ChatEvent) => void;

  setAskListener(listener: (keys: readonly string[], event: ChatEvent) => void): void {
    this.onAsk = listener;
  }

  /**
   * CLI вернул результат вызова. Слушатель — брокер прав (`ChatSession`): запрос
   * по этому вызову, если ещё висит, мёртв — CLI его оборвал и ответа не ждёт.
   */
  private onToolResult?: (runKey: string, toolUseId: string) => void;

  setToolResultListener(listener: (runKey: string, toolUseId: string) => void): void {
    this.onToolResult = listener;
  }

  /**
   * Продолжать ли сессию на этом старте (F-05 ревью П1, директива §L4). Одна
   * точка на ВСЕ продолжения — повтор после лимита, «Продолжить всё», ответ
   * человека, отложенный старт, звенья: прежде правило знал только запуск
   * стадий, и остальные пути продолжали остывший разговор, записывая всё окно в
   * кэш заново. Решение — на момент запуска, а не на момент, когда старт отложили.
   */
  private continuationOf?: ContinuationPolicy;

  setContinuationPolicy(policy: ContinuationPolicy): void {
    this.continuationOf = policy;
  }

  /**
   * Параметры этого старта после решения о продолжении. Ход, начатый самим CLI
   * (`wake`/`hold`), — продолжение уже идущей сессии, его не переигрывают.
   * Отметка `afterLimit` в запись прогона не попадает ни при каком ответе.
   */
  private continuation(
    keys: readonly string[],
    options: RunOptions,
    askedMeta: RunMeta,
  ): { options: RunOptions; meta: RunMeta; notice?: ChatEvent } {
    const { afterLimit, keepSession, ...meta } = askedMeta;
    // Человек сам вернул ход в старую сессию (R5): правило остывшей не спрашиваем.
    if (keepSession || !options.sessionId || options.wake || options.hold || !this.continuationOf) {
      return { options, meta };
    }
    try {
      const decided = this.continuationOf(keys, options, {
        ...meta,
        ...(afterLimit ? { afterLimit } : {}),
      });
      if (!decided) return { options, meta };
      const { afterLimit: _limit, ...decidedMeta } = decided.meta;
      return { ...decided, meta: decidedMeta };
    } catch {
      // Решение не главнее хода: осечка чтения транскрипта оставляет продолжение.
      return { options, meta };
    }
  }

  /**
   * Выбранная группа разговора (своя или от родителя) — включить к старту. Одна
   * точка на ВСЕ старты: отправка человека, звенья конвейера, дети разделения,
   * ревью, слово родителя; маршруты по отдельности кто-нибудь да пропускал
   * (дети разделения стартовали без группы родителя). Зовётся ДО подъёма
   * процесса, синхронно; вернула заметку — та ложится в ленту прогона.
   */
  private groupActivationOf?: (keys: readonly string[], cwd: string) => ChatEvent | undefined;

  setGroupActivation(
    activate: (keys: readonly string[], cwd: string) => ChatEvent | undefined,
  ): void {
    this.groupActivationOf = activate;
  }

  /**
   * Правда о каталоге прогона к системному промпту (тесты проекта, папка e2e).
   * Одна точка на все старты — по той же причине, что и включение группы выше.
   */
  private workspaceNoteOf?: (cwd: string) => string | undefined;

  /** `group` — прогон группы разделения: ей строка о тестах в своей редакции (1.4). */
  setWorkspaceNote(resolve: (cwd: string) => string | undefined): void {
    this.workspaceNoteOf = resolve;
  }

  /** Строки о тестах по сессиям: системная — одна на сессию (E6). */
  private readonly workspaceNotes = new SessionWorkspaceNotes();

  /**
   * Строки хода о тестах. Осечка чужого слушателя старт не срывает: новая
   * сессия уходит без строки, а продолженная — со своей прежней и без
   * перемены (сбой чтения — не повод сказать агенту, что тестов больше нет).
   */
  private workspaceTurn(cwd: string, sessionId: string | undefined, prompt: string): NoteTurn {
    let current: string;
    try {
      current = this.workspaceNoteOf?.(cwd) ?? '';
    } catch {
      return this.workspaceNotes.turn(sessionId, '', false);
    }
    return this.workspaceNotes.turn(sessionId, current, !isCliCommand(prompt));
  }

  /**
   * Лёгкий профиль запуска группы разделения (1.2): какие MCP-серверы едут в её
   * прогон. Спрашивается на КАЖДОМ старте — группа могла попросить сервер блоком
   * `mcp` между ходами. Нет ответа — прогон не группы, профиль не трогается.
   */
  private groupProfileOf?: (keys: readonly string[], cwd: string) => GroupRunProfile | undefined;

  setGroupProfileResolver(
    resolver: (keys: readonly string[], cwd: string) => GroupRunProfile | undefined,
  ): void {
    this.groupProfileOf = resolver;
  }

  /** Локальный слой проекта по рабочей папке прогона (`domains/local-layer`); спрашивается на каждом старте. */
  private localLayerOf?: (cwd: string) => LayerRunExtras | undefined;

  setLocalLayerResolver(resolver: (cwd: string) => LayerRunExtras | undefined): void {
    this.localLayerOf = resolver;
  }

  /** Схемы, снятые настройкой панели `chatLeanTools`; спрашивается на каждом старте. */
  private deniedToolsOf?: () => readonly string[];

  setDeniedToolsResolver(resolver: () => readonly string[]): void {
    this.deniedToolsOf = resolver;
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

  /**
   * Ответ усыновлённого прогона: потока у него нет, но текст лежит в транскрипте
   * Claude Code. Крючок ставит bootstrap — каталог транскриптов знает он, а
   * реестр о каталогах конфигурации не знает ничего.
   */
  private readClosingTurn?: (chatId: string, sessionId?: string) => ClosingTurn | undefined;

  setClosingTurnReader(
    read: (chatId: string, sessionId?: string) => ClosingTurn | undefined,
  ): void {
    this.readClosingTurn = read;
  }

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
    this.ledger.upsert(this.ledgerEntry(key, run));
  }

  /**
   * Запись журнала об идущем прогоне. Полей `relay`/`idle` сервер больше не
   * пишет (этап 10, G14: посредника живой сессии нет) — их читает только
   * `adopt` у записей сервера прежней версии.
   */
  private ledgerEntry(key: string, run: RegisteredRun): RunLedgerEntry {
    const pid = run.cliPid ?? run.run.pid;
    const autoApprove = this.snapshotAutoApprove?.(key);
    return {
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
      ...(run.options.permissionMode ? { permissionMode: run.options.permissionMode } : {}),
      // Тот же CLI на продолжении усыновлённого прогона (EF-190), а не `claude` из PATH.
      ...ledgerLaunchOf(run.options),
      ...(run.meta.origin ? { origin: run.meta.origin } : {}),
      ...(run.meta.local ? { local: true as const } : {}),
      ...(run.pids ? { pids: run.pids } : {}),
    };
  }

  /**
   * Усыновить прогон из журнала после перезапуска панели: процесс жив, трубы к
   * нему нет. Прогон встаёт в реестр под прежним ключом — брокер прав находит
   * его по `PERM_RUN_ID` и рисует карточку в его чате; «Остановить» валит дерево
   * по pid; конец определяется по жизни pid (`DetachedRun`). Первым в поток
   * уходит событие сессии: по нему вкладка узнаёт ключ и время старта, а
   * заметка о подхвате — следом, из самого прогона. false — усыновлять нечего:
   * pid не записан или под этим ключом уже что-то идёт.
   *
   * Процесс за посредником в пул больше не встаёт (этап 10, G14): вести сессию
   * за посредником умел только снятый прогон панели, а фабрика реестра отдаёт
   * прогон ядра — разбуженный по той же сессии, он поднимал второй CLI с
   * `--resume`, пока первый жил за посредником. Посреднику закрывают ввод: CLI
   * доделает ход и выйдет, ждущий — выйдет сразу, конец хода — по жизни pid.
   */
  adopt(entry: RunLedgerEntry, deps: DetachedRunDeps = {}): boolean {
    if (entry.pid === undefined || this.runs.has(entry.key)) return false;
    const options = ledgerRunOptions(entry);
    const meta = ledgerRunMeta(entry);
    if (entry.relay) endRelayInput(entry);
    // Ждущему процессу прогон не нужен: ввод закрыт, ход заведёт человек — уже ядром.
    if (entry.idle) return false;
    const run = new DetachedRun(entry.pid, entry.startedAt, deps);
    const registered: RegisteredRun = {
      chatId: entry.key,
      run,
      meta,
      options,
      startedAt: entry.startedAt,
      text: '',
      events: [],
      eventBytes: 0,
      trimmedSeq: 0,
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
      ...(entry.pids ? { pids: entry.pids } : {}),
      ...(entry.relay?.background ? { ledgerBackground: entry.relay.background } : {}),
    };
    this.runs.set(entry.key, registered);
    // Потока у такого прогона нет: сторож групп читает сессию из её транскрипта.
    this.feedWatch(entry.key, {
      kind: 'start',
      cwd: options.cwd,
      detached: true,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    });
    if (entry.sessionId) {
      this.emit(registered, {
        kind: 'session',
        sessionId: entry.sessionId,
        model: entry.model ?? '',
        tools: 0,
      });
    }
    void run
      .start(options, (event) => this.emit(registered, event))
      .then(() => this.finish(registered))
      .catch(() => this.finish(registered));
    return true;
  }

  /**
   * Поздний подхват: живой CLI, которого единственный обход при старте не поймал.
   *
   * Обход был ровно один, и промахнуться он мог по двум причинам: pid приезжает в
   * журнал асинхронно (поиск процесса под оболочкой идёт через CIM, ~0,8 с), а
   * `tasklist` на занятой машине отвечает не всегда. Промах стоил дорого: агент
   * получал отказ на КАЖДЫЙ запрос прав до конца своей жизни, и человеку
   * оставалось переслать сообщение. Проверки те же, что у обхода (возраст, живой
   * pid, похожий на CLI образ), цена — одно чтение файла на неизвестный прогон.
   *
   * Запись при неудаче НЕ вычищаем: чистка — дело обхода при старте, а здесь
   * промах может быть гонкой с ещё дописывающимся pid.
   */
  adoptFromLedger(
    runId: string,
    probe: { isAlive: (pid: number) => boolean; looksLikeCli: (pid: number) => boolean } = {
      isAlive: isPidAlive,
      looksLikeCli: pidLooksLikeCli,
    },
    deps: DetachedRunDeps = {},
  ): RunLedgerEntry | undefined {
    if (!this.ledger) return undefined;
    if (this.runs.has(this.resolveKey(runId))) return undefined;
    // Ключ прогона в журнале записан дважды: временным `new-…` и настоящим
    // `sessionId`. Брокер прав знает то написание, с которым прогон стартовал.
    const entry = this.ledger.read().find((item) => item.key === runId || item.sessionId === runId);
    if (!entry) return undefined;
    const [adoptable] = adoptableEntries([entry], probe).adopt;
    if (!adoptable || !this.adopt(adoptable, deps)) return undefined;
    return adoptable;
  }

  /**
   * Фабрика прогона: в сервере — прогон ядра (`CoreChatRun`, `chat-wiring.ts`), в
   * тестах — управляемый фейк. Своего запуска CLI у панели нет (этап 10, G14):
   * реестр без фабрики годится только тем, кто прогонов не заводит, и на старте
   * отвечает отказом, а не молча поднятым процессом.
   *
   * Поле присваивается вручную: Node исполняет TypeScript в режиме strip-only
   * и parameter properties не поддерживает — с ними сервер не стартует вовсе.
   */
  constructor(createRun?: RunFactory) {
    this.createRun = createRun ?? noRunFactory;
  }

  /**
   * Запрос прав пришёл фоновому субагенту разговора: карточка показывается в идущем
   * прогоне. Своих живых процессов между ходами у панели нет (этап 10, G14: ход ведёт
   * ядро), так что `true` — только когда у разговора идёт прогон.
   */
  hostBackgroundAsk(runId: string): boolean {
    return this.isRunning(runId);
  }

  /**
   * Самый поздний ход разговора по любому из ключей — его параметры ответу из
   * Telegram: после остывшего продолжения у разговора две сессии, и продолжать
   * надо нынешнюю. Идущий ход — самый поздний. Иначе — память законченных ходов
   * (`wakeable`), упорядоченная концом хода.
   */
  latestRunOf(keys: readonly string[]): LatestRun | undefined {
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || !run.sessionId || run.detached) continue;
      if (!keys.includes(run.chatId) && !keys.includes(run.sessionId)) continue;
      return {
        chatId: run.chatId,
        sessionId: run.sessionId,
        options: run.options,
        meta: run.meta,
      };
    }
    let found: LatestRun | undefined;
    for (const [sessionId, last] of this.wakeable) {
      if (keys.includes(sessionId) || keys.includes(last.chatId)) {
        found = {
          chatId: last.chatId,
          sessionId,
          options: last.options,
          meta: last.meta,
        };
      }
    }
    return found;
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
      ...(run.woken ? { woken: true as const } : {}),
    };
  }

  /**
   * Жив ли процесс CLI разговора — идёт ли его прогон. Ждущих следующего хода
   * процессов у панели нет (этап 10, G14): между ходами фон держит ядро.
   */
  isProcessAlive(chatId: string): boolean {
    return this.isRunning(chatId, chatId);
  }

  /**
   * Номера процессов идущего прогона разговора — обёртка, сам CLI и звенья записи журнала:
   * корни дерева, которое сторож повисших групп пишет в журнал перед снятием.
   */
  processRootsOf(chatId: string): number[] {
    const run = this.runs.get(this.resolveKey(chatId));
    if (!run) return [];
    const pids = [run.run.pid, run.cliPid, ...(run.pids ?? [])];
    return [...new Set(pids.filter((pid): pid is number => typeof pid === 'number' && pid > 0))];
  }

  /**
   * Корни процессов ВСЕХ прогонов панели. Решение человека
   * (права, D-n, ворота ветки), пришедшее от потомка любого из них, — решение
   * модели, а не человека: маршруты решений отказывают ему (`human-only.ts`).
   */
  allProcessRoots(): number[] {
    const roots = new Set<number>();
    for (const key of this.runs.keys()) for (const pid of this.processRootsOf(key)) roots.add(pid);
    return [...roots];
  }

  /**
   * Сообщение человека посреди идущего хода — агенту сразу, а не после конца
   * хода: агент дочитывает текущий шаг, видит сообщение и учитывает его, как в
   * самом Claude Code. Событие `steer` уходит в поток прогона — вкладки
   * показывают сообщение сразу. `false` — прогона нет, он не живой или процесс
   * не принял сообщение: вызывающий ставит его в очередь, как раньше.
   */
  steer(chatId: string, sessionId: string | undefined, prompt: string): boolean {
    const run = this.runs.get(this.resolveKey(chatId, sessionId));
    if (!run || run.status !== 'running' || !prompt.trim()) return false;
    if (!run.run.steer?.(prompt)) return false;
    this.emit(run, { kind: 'steer', text: prompt, at: new Date().toISOString() });
    return true;
  }

  isRunning(chatId: string, sessionId?: string): boolean {
    return this.runs.get(this.resolveKey(chatId, sessionId))?.status === 'running';
  }

  /**
   * Убрать законченный прогон из буфера догона раньше срока. Буфер нужен, чтобы
   * вкладка дотянула хвост хода; у разговора отменённого плана хвост — вопрос,
   * на который никто не ждёт ответа, и вкладка после F5 снова звала бы «агент
   * ждёт ответа» (живая приёмка 09.10). Идущий прогон не трогаем.
   */
  discardFinished(chatId: string): boolean {
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run || run.status === 'running') return false;
    this.remove(key);
    return true;
  }

  /**
   * Идёт ли в каталоге другой прогон, кроме названных ключей (журнал 90): два
   * агента в одной копии правят одно дерево наперегонки, и звено, заведённое
   * поверх продолженного человеком разговора, работало по чужим правкам.
   * `counts` сужает круг: прогон чужой группы в общем каталоге (проект без git —
   * копий нет) не мешает, иначе итог группы терялся навсегда.
   */
  runningIn(
    cwd: string,
    except: readonly string[] = [],
    counts: (other: { chatId: string; sessionId?: string }) => boolean = () => true,
  ): boolean {
    const target = normalizePath(cwd);
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      if (except.includes(run.chatId)) continue;
      if (run.sessionId && except.includes(run.sessionId)) continue;
      const dir = run.meta.projectPath ?? run.options.cwd;
      if (!dir || normalizePath(dir) !== target) continue;
      if (counts({ chatId: run.chatId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) })) {
        return true;
      }
    }
    return false;
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
  start(chatId: string, asked: RunOptions, askedMeta: RunMeta): boolean {
    // Ищем прогон по ОБОИМ написаниям ключа (см. resolveKey): иначе вторая
    // вкладка того же разговора заводила второй процесс мимо этой проверки.
    const existingKey = this.resolveKey(chatId, askedMeta.sessionId);
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

    // Связи ищутся под ключами ПРОСИМОГО разговора: новая сессия вместо
    // остывшей своего ключа ещё не имеет, а звено — то же.
    const keys = askedMeta.sessionId ? [chatId, askedMeta.sessionId] : [chatId];
    // Сводка детей снимается до всего остального: под ней мог остаться блок
    // перемены прошлой попытки, и снять его можно, только пока он стоит первым —
    // то есть и до вводной нового разговора, которую решение ставит в начало.
    const plain = { ...asked, prompt: withoutChildrenBrief(asked.prompt) };
    const turn = this.continuation(keys, plain, askedMeta);
    const { options, meta } = turn;
    const { afterLimit: _limit, keepSession: _keep, ...originMeta } = askedMeta;
    const cold = turn.notice?.kind === 'notice' && turn.notice.code === 'coldResume';
    const said = options.prompt;
    const { routed, routedMeta, route, workspace } = this.compose(keys, options, meta, said);
    const run = this.createRun();
    // `wake`/`hold` — про ЭТОТ старт (ход, начатый самим CLI), не про разговор.
    // Из параметров прогона их заводит всё следующее: продолжение той же сессией,
    // звено, тёплая доставка, журнал для подхвата. С ними такой старт забирал бы
    // несуществующий ход CLI и молча не шёл — недоделанное уезжало в ревью.
    const { wake: _wake, hold: _hold, ...kept } = routed;
    const registered: RegisteredRun = {
      chatId,
      run,
      meta: routedMeta,
      options: kept,
      ...(cold ? { coldOrigin: { options: plain, meta: originMeta } } : {}),
      ...(routed.wake ? { woken: true as const } : {}),
      ...(route.model?.model ? { routed: true as const } : {}),
      ...(route.model?.model && route.modelMapKeys ? { routedMap: route.modelMapKeys } : {}),
      startedAt: Date.now(),
      text: '',
      events: [],
      eventBytes: 0,
      trimmedSeq: 0,
      seq: 0,
      status: 'running',
      errored: false,
      sessionId: meta.sessionId,
      subscribers: new Set(),
      spentCostUsd: 0,
      spentTokens: 0,
      contextTokens: 0,
      checks: [],
      workspace: workspace.state,
    };
    this.runs.set(chatId, registered);
    // Сначала конвейер переводит группу в «стартует», потом сторож снимает её состояние на старте хода:
    // в обратном порядке продолжение с паузы снималось «на паузе» и первый же вызов давал R20 (25.10).
    try {
      this.onRunStart?.(meta.sessionId ? [chatId, meta.sessionId] : [chatId]);
    } catch {
      // Слушатель чужой: его сбой не имеет права сорвать старт прогона.
    }
    this.feedWatch(chatId, {
      kind: 'start',
      sessionId: meta.sessionId,
      cwd: kept.cwd,
      // Длина вводной, ушедшей в CLI (R37): сборка панели — вводная, правила, сводка детей.
      ...(typeof kept.prompt === 'string' ? { promptChars: kept.prompt.length } : {}),
      // Ответвление тёплой сессии: сторожу R2 нужен конец её последнего вызова.
      ...(options.fork && options.sessionId ? { forkOf: options.sessionId } : {}),
    });
    // Отказанный контуром прогон не стартует вовсе — и группу включать не за
    // чем: включение пишет в каталог конфига и пережило бы несостоявшийся ход.
    try {
      const notice = route.refusal
        ? undefined
        : this.groupActivationOf?.(
            meta.sessionId ? [chatId, meta.sessionId] : [chatId],
            options.cwd,
          );
      if (notice) this.emit(registered, notice);
    } catch {
      // Группа не главнее разговора: осечка включения старт не срывает.
    }
    // Человек видит, что остывший разговор не продолжен и почему (F-05).
    if (turn.notice) this.emit(registered, turn.notice);

    // Отказанный контуром прогон не получил ничего — и записывать нечего.
    if (!route.refusal) {
      try {
        this.inputJournal?.(
          meta.sessionId ? [chatId, meta.sessionId] : [chatId],
          receivedInputOf(routed, registered.startedAt),
        );
      } catch {
        // Сверка входа не главнее прогона: сбой записи старт не срывает.
      }
    }

    // Отказ обязательного контура — ошибка прогона тем же путём, что и сбой
    // CLI: процесс не поднимается вовсе, а человек видит причину в ленте.
    const launch = route.refusal
      ? Promise.reject(new Error(route.refusal))
      : run.start(routed, (event) => this.emit(registered, event));
    void launch
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
    if (this.ledger) void this.trackPids(registered).catch(() => {});

    return true;
  }

  /**
   * Параметры старта поверх решения о продолжении: маршрут контура, профиль
   * группы, наши слои, строка о тестах, снятые инструменты, метка автономии —
   * всё, что решается на КАЖДОМ старте.
   */
  private compose(
    keys: readonly string[],
    options: RunOptions,
    meta: RunMeta,
    said: string,
  ): { routed: RunOptions; routedMeta: RunMeta; route: PlatformRunRoute; workspace: NoteTurn } {
    const workspace = this.workspaceTurn(options.cwd, options.sessionId ?? meta.sessionId, said);
    // Маршрут решается ЗДЕСЬ, на каждом старте: продолжение остановленного
    // прогона приходит со СТАРЫМИ параметрами (пауза дерева, продолжение в
    // чистой сессии), и адрес контура, оставшийся в них с прошлой жизни,
    // пережил бы снятую галочку. Пустой объект — законный ответ «не через
    // контур», и он затирает прежний.
    const route = this.platformRouting?.(meta.origin ?? 'chat', options.model ?? '') ?? { env: {} };
    // У контура и локальной модели свой `--strict-mcp-config` и свой выбор
    // серверов: от профиля группы там остаётся всё, кроме MCP, — запрет правок
    // лёгкого чата, хуки, очередь тяжёлых шагов, перечень навыков. Прежде такой
    // прогон терял профиль целиком (ревью A1-F4/B1-F2).
    const strict = Boolean(route.layers?.args.includes('--strict-mcp-config'));
    const fromRoute = route.localMcp?.(options.cwd);
    const resolved = this.groupProfileOf?.(keys, options.cwd);
    const stripped = resolved && (strict || fromRoute) ? withoutMcp(resolved) : resolved;
    // Окно сжатия и потолок чтения группы не выше пределов маршрута (n2, n1): см. route-caps.
    const profile = stripped && capProfileToRoute(stripped, route);
    const mcp = fromRoute ?? profile?.mcp;
    const baseArgs = [
      ...(route.layers?.args ?? []),
      ...(route.kit?.args ?? []),
      ...(profile?.args ?? []),
    ];
    // Локальный слой проекта: командный слой из `.agent/local-layer/` вместо
    // самого командного (`--setting-sources` без `project`). Песочница со своим
    // каталогом конфигурации и маршрут, уже снявший `project`, его не получают —
    // и слой для них даже не собирается. Части слоя едут в ядро полем
    // `session.localLayer` (s10 G14 p6); серверы `.mcp.json` ядро предлагает само.
    const layerSources =
      options.configDir || options.settingSources ? undefined : withoutProjectSource(baseArgs);
    const layered = layerSources ? this.localLayerOf?.(options.cwd) : undefined;
    const routed: RunOptions = {
      ...options,
      // Модель и усилие принадлежат КОНТУРУ, пока прогон идёт через него (Т6):
      // имя вендора контур не знает (403 «модель»), а усилия он не принимает
      // вовсе — `--effort` уехал бы платной просьбой, которую никто не выполнит.
      // Не через контур — поля отсутствуют, и выбор человека остаётся как был.
      ...(route.model?.model ? { model: route.model.model } : {}),
      ...(route.effort === false ? { effort: '' } : {}),
      // Авторежим решён по модели, которую ПРОСИЛИ; контур мог подставить свою.
      // Без авторежима у неё CLI молча опустил бы `auto` до `default`, и прогон
      // спрашивал бы каждую правку, — такой идёт в `acceptEdits`, а рутину
      // снимает автоподтверждение панели (`providers/claude-auto-mode.ts`).
      ...(options.permissionMode === 'auto' &&
      route.model?.model &&
      !claudeModelHasAutoMode(route.model.model)
        ? { permissionMode: 'acceptEdits' }
        : {}),
      // Набор панели (В2) едет своим полем: и мимо контура, и поверх него —
      // но его потолки не выше пределов маршрута (route-caps, ревью K 🟡1).
      platformEnv: {
        ...route.env,
        ...capKitToRoute(route),
        ...profile?.env,
      },
      // Промпт контура ставится и СНИМАЕТСЯ здесь же: прогон, продолженный
      // после выключенной галочки, обязан вернуться к промпту CLI.
      platformSystemPrompt: route.systemPrompt ?? '',
      // Наши слои (Т8): и флаги снятия, и судьба нашей дописки к системному
      // промпту (инициативы, разделение, продолжение) решаются на КАЖДОМ старте
      // и кладутся безусловно — прошлая жизнь прогона не переживает ни снятую
      // галочку, ни возвращённую. Сам текст дописки при этом не трогается:
      // затёртый, он не вернулся бы после паузы дерева (ревью Т8, MAJOR-4).
      platformArgs: layered && layerSources ? layerSources : baseArgs,
      platformDropAppend: route.layers ? !route.layers.systemPrompt : false,
      // Блок набора к системному промпту (дисциплина локальной модели при режиме «глобальные»): решается на каждом старте, как и остальной маршрут.
      platformAppend: route.kit?.append ?? '',
      // Строка профиля группы: что подключено, что снято и как попросить снятое.
      profileNote: profile?.note ?? '',
      // Перечень навыков группы (1.3) — настройками поверх личных, тоже на каждом старте.
      platformSettings: profile?.settings ?? {},
      // Инструкции, плагин, хуки и права слоя — полем ядра; слой «системный промпт»
      // инструкций не снимает: это правила проекта, а не наша дописка.
      ...(layered ? { localLayer: localLayerCarry(layered) } : {}),
      // MCP-серверы, взятые человеком в локальный прогон этого проекта: выбор меняется
      // между ходами, поэтому читается на каждом старте и кладётся безусловно.
      ...(mcp ? { platformMcp: mcp } : {}),
      // Одна на сессию (E6): перемена между ходами уезжает в сообщении ниже.
      workspaceNote: workspace.system,
      // Настройка панели читается на каждом старте и кладётся безусловно: снятая
      // галочка возвращает инструменты следующему ходу, а не новому разговору.
      deniedTools: this.deniedToolsOf?.() ?? [],
      // Пинг тёплого кэша идёт своим словом: перемена строки о тестах принадлежит
      // ходу человека, а не ему. Сводку детей (Д6) ставил конвейер разделения, он
      // снят (этап 10, G14); прежняя сводка в параметрах прошлой попытки снимается.
      prompt: withoutChildrenBrief(withWorkspaceUpdate(said, workspace.update)),
    };
    // Выбор, снятый между ходами, не переживает продолжение: прежние параметры несли поле.
    if (!mcp) delete routed.platformMcp;
    // Слой, выключенный между ходами, не переживает продолжение (режим карточки «Выкл.»).
    if (!layered) delete routed.localLayer;
    // Журнал понижений отвечает на «окупается ли понижение», и отвечать он обязан
    // моделью, которой прогон ШЁЛ. Через контур это модель маршрута, а не имя из
    // шапки: иначе расход считался бы по модели, которой прогона не было (ревью
    // Т6, m8). Глубина, которую контур не принимает, в журнал тоже не пишется.
    const { local: _stale, ...freshMeta } = meta;
    const withLowered: RunMeta = freshMeta.lowered
      ? {
          ...freshMeta,
          lowered: {
            ...freshMeta.lowered,
            ...(route.model?.model ? { model: route.model.model } : {}),
            ...(route.effort === false ? { effort: '' } : {}),
          },
        }
      : freshMeta;
    // Отметка решается на каждом старте, как и маршрут: продолжение приходит со старой.
    const routedMeta: RunMeta = this.localOf?.(routed, freshMeta)
      ? { ...withLowered, local: true }
      : withLowered;
    return { routed, routedMeta, route, workspace };
  }

  /**
   * Первая запись — с номером обёртки, чтобы окно без записи было нулевым; как
   * только под ней найден сам CLI, запись переписывается его номером.
   */
  private async trackPids(registered: RegisteredRun): Promise<void> {
    const shell = registered.run.pid;
    if (shell === undefined) return;
    const cliPid = await this.resolvePid(shell);
    if (cliPid === shell) return;
    registered.cliPid = cliPid;
    if (registered.status === 'running') this.persist(registered.chatId);
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
    if (!run.detached) {
      const sessionId = event.kind === 'session' ? event.sessionId : run.sessionId;
      this.feedWatch(run.chatId, { kind: 'event', event, sessionId });
    }
    // Сжатие окна (R3), повтор запроса к модели (R30) и конец фоновой задачи (R16) — только
    // сторожу, в ленту не идут.
    if (event.kind === 'compact' || event.kind === 'apiRetry' || event.kind === 'bgDone') return;
    // Хук Stop отбил конец хода: итог звена — ответ до ПЕРВОГО замечания (P1), ответ на
    // замечание его не заменяет. Вкладкам событие не нужно.
    if (event.kind === 'stopFeedback') {
      run.summary ??= run.answer ?? '';
      return;
    }
    // Внутреннее событие: вкладкам и буферу его знать незачем.
    if (event.kind === 'toolResult') {
      run.toolResults = (run.toolResults ?? 0) + 1;
      try {
        this.onToolResult?.(run.chatId, event.toolUseId);
      } catch {
        // Слушатель чужой: поток прогона обязан идти дальше.
      }
      return;
    }
    // Запоминаем sessionId — его отдаёт /chat/active для переподключения после F5.
    const knownSession = run.sessionId;
    if (event.kind === 'session') run.sessionId = event.sessionId;
    if (event.kind === 'done' && event.sessionId) run.sessionId = event.sessionId;
    // Строка о тестах запоминается за сессией, как только та названа: следующий
    // ход получит ту же системную строку (E6). Ответвлённая сессия наследует
    // строку прежней — её переписка и кэш начинаются с того же промпта.
    if ((event.kind === 'session' || event.kind === 'done') && run.sessionId && run.workspace) {
      this.workspaceNotes.remember(run.sessionId, run.workspace);
    }
    // Ключ разговора стал настоящим — сообщаем ровно один раз, на смене. Журнал
    // на диске тоже узнаёт второе написание: после перезапуска по нему находят
    // прогон вкладки, знающие разговор по sessionId.
    if (run.sessionId && run.sessionId !== knownSession) {
      // Прежняя сессия — правка сообщения ответвила разговор (`--fork-session`):
      // слушателю это другое событие, чем первый ход временного ключа (F-111).
      this.onSession?.(run.chatId, run.sessionId, knownSession);
      this.persist(run.chatId);
    }
    if (event.kind === 'error') {
      run.errored = true;
      run.lastError = event.message;
    }
    if (event.kind === 'limit') run.limit = { resetsAt: event.resetsAt, status: event.status };
    // Различные замеры, и запись в журнале обновляется по ходу: доля на
    // карточке не ждёт конца многочасового звена.
    if (event.kind === 'limit' && event.sample) {
      run.limitSamples = withLimitSample(run.limitSamples ?? [], event.sample);
      const now = Date.now();
      if (run.limitJournalAt === undefined || now - run.limitJournalAt >= LIMIT_JOURNAL_EVERY_MS) {
        run.limitJournalAt = now;
        this.writeLimitJournal(run, now, true);
      }
    }
    // Вопрос агента — ожидание человека: автовыбора панели больше нет (автономия
    // чатов ушла в ядро), отложить сигнал до результата вызова нечем.
    if (event.kind === 'tool' && event.name === 'AskUserQuestion') {
      if (event.id) (run.askInputs ??= new Map()).set(event.id, event.input);
      if (!event.id) run.askedUnkeyed = true;
      run.asked = true;
    }
    // Автовыбор узнан по результату вызова: `critical` знает только тело
    // вопроса, поэтому выбор пересчитывается по нему, если панель его видела.
    let picked: Extract<ChatEvent, { kind: 'autoPick' }> | undefined;
    if (event.kind === 'autoPick') {
      if (run.autoPicked?.has(event.toolUseId)) return;
      (run.autoPicked ??= new Set()).add(event.toolUseId);
      const input = run.askInputs?.get(event.toolUseId);
      // Выбор — из текста отказа (ответ «по плану» берёт не всегда
      // рекомендованный), из тела — только `critical`; текст не разобрался —
      // считаем по телу.
      picked = {
        ...event,
        picks: input === undefined ? event.picks : confirmedPicks(input, event.picks),
      };
      if (picked.picks.length === 0) picked = event;
      run.asked =
        run.askedUnkeyed === true ||
        [...(run.askInputs?.keys() ?? [])].some((id) => !run.autoPicked?.has(id));
    }
    // Текст копим ХВОСТОМ: планировщику продолжения нужен конец ответа, а не
    // весь разговор (см. TEXT_TAIL).
    if (event.kind === 'text') {
      run.text = (run.text + event.text).slice(-TEXT_TAIL);
      run.answer = ((run.answer ?? '') + event.text).slice(-TEXT_TAIL);
    }
    // Вызов инструмента закрывает промежуточный текст: итог — то, что после последнего.
    if (event.kind === 'tool') run.answer = '';
    // Граница хода внутри прогона (слово «на ходу» начало свой ход, чат на ядре): итог прогона —
    // ответ последнего хода, а хвост ходы разделяет абзацем. Без этого уведомление и планировщик
    // конца читали оба ответа одной склейкой («готовготов», core-chat-012).
    if (event.kind === 'nextTurn') {
      run.answer = '';
      if (run.text && !run.text.endsWith('\n\n')) run.text = `${run.text}\n\n`.slice(-TEXT_TAIL);
    }

    // Накопленный расход считаем здесь, на сервере: тогда счётчик за сеанс не
    // обнуляется при перезагрузке вкладки, как и сами прогоны. Дублируем вклад в
    // самом прогоне (spent*) — чтобы при ретрае упавшей попытки откатить именно
    // её долю из общего счётчика, а не гадать.
    let outgoing = picked ?? event;
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
      const costUsd =
        event.model && this.estimateStepCost
          ? this.estimateStepCost(event.model, event)
          : undefined;
      if (costUsd !== undefined) outgoing = { ...event, costUsd };
      if (event.model && this.estimateStepCost && !event.remainder) {
        if (costUsd === undefined) run.unpricedSteps = (run.unpricedSteps ?? 0) + 1;
        else run.pricedSteps = (run.pricedSteps ?? 0) + 1;
      }
      if (event.genMs && event.messageId) {
        try {
          this.noteGenTime?.(event.messageId, event.genMs, event.model);
        } catch {
          // Журнал скорости не главнее потока прогона.
        }
      }
    }
    if (event.kind === 'done') {
      // Ни одного шага с ценой — ход сделала модель, которая не стоит ничего.
      const unpriced = (run.unpricedSteps ?? 0) > 0 && (run.pricedSteps ?? 0) === 0;
      const costUsd = unpriced ? 0 : event.costUsd;
      if (unpriced) outgoing = { ...outgoing, costUsd } as typeof outgoing;
      run.spentCostUsd += costUsd;
      this.totalCostUsd += costUsd;
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
      const question = firstQuestionOf(event.input);
      this.notify?.({
        kind: 'question',
        chatId: run.chatId,
        projectPath: run.meta.projectPath,
        ...(question ? { question } : {}),
      });
    }
    if (
      this.onAsk &&
      (event.kind === 'permission' ||
        event.kind === 'permissionResolved' ||
        event.kind === 'autoPick' ||
        (event.kind === 'tool' && event.name === 'AskUserQuestion'))
    ) {
      try {
        this.onAsk(run.sessionId ? [run.chatId, run.sessionId] : [run.chatId], event);
      } catch {
        // Молча: запись вопроса — для хаба, а поток прогона обязан идти дальше.
      }
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
    this.trimBuffer(run, buffered);
    for (const subscriber of run.subscribers) subscriber.send(buffered);
  }

  /** Держит буфер в пределах: старые кадры уходят, последний остаётся. */
  private trimBuffer(run: RegisteredRun, latest: BufferedEvent): void {
    try {
      run.eventBytes += JSON.stringify(latest.event).length;
    } catch {
      // Кадр без JSON-вида в поток всё равно ушёл; считаем его пустым.
    }
    if (run.events.length <= MAX_BUFFERED_EVENTS && run.eventBytes <= MAX_BUFFERED_BYTES) return;
    // Режем пачкой (десятая часть предела), а не по кадру: сдвиг массива не на каждый кадр.
    let drop = Math.max(0, run.events.length - MAX_BUFFERED_EVENTS) + MAX_BUFFERED_EVENTS / 10;
    let bytes = run.eventBytes;
    let count = 0;
    const last = run.events.length - 1;
    while (count < last && (count < drop || bytes > MAX_BUFFERED_BYTES * 0.9)) {
      const gone = run.events[count];
      if (!gone) break;
      try {
        bytes -= JSON.stringify(gone.event).length;
      } catch {
        // см. выше
      }
      run.trimmedSeq = gone.seq;
      count += 1;
    }
    drop = count;
    run.events.splice(0, drop);
    run.eventBytes = Math.max(0, bytes);
  }

  /**
   * Ответ усыновлённого прогона из транскрипта. Ошибка чтения — пусто: чужой
   * файл не имеет права уронить завершение прогона.
   */
  private closingTurnOf(run: RegisteredRun): ClosingTurn | undefined {
    if (run.errored || !this.readClosingTurn) return undefined;
    try {
      return this.readClosingTurn(run.chatId, run.sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * Факты конца хода для уведомления: итог, висящий вопрос со своими
   * вариантами, обрыв, фон, уехавшая работа. Вопрос — последний, который не
   * закрыл автовыбор; усыновлённый прогон тел вопросов не видел — тогда что
   * решить, скажет сам ответ.
   */
  private turnFacts(
    run: RegisteredRun,
    seen: { answer: string; asked: boolean; interrupted: boolean; continued: boolean },
  ): Partial<RunNotice> {
    const pending = seen.asked
      ? [...(run.askInputs?.entries() ?? [])].filter(([id]) => !run.autoPicked?.has(id)).at(-1)?.[1]
      : undefined;
    const question = pending === undefined ? undefined : firstQuestionOf(pending);
    const options = pending === undefined ? [] : questionOptionsOf(pending);
    return {
      ...(seen.answer.trim() ? { answer: seen.answer } : {}),
      ...(seen.asked ? { asked: true } : {}),
      ...(question ? { question } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(seen.interrupted ? { interrupted: true } : {}),
      ...(seen.continued ? { continued: true } : {}),
      turnKey: String(run.startedAt),
    };
  }

  /** Прогон завершился сам (процесс закрылся). */
  private finish(run: RegisteredRun): void {
    if (run.status !== 'running') return;
    run.status = run.errored ? 'error' : 'done';
    run.finishedAt = Date.now();
    // Ждущих следующего хода процессов у панели нет (этап 10, G14): запись уходит.
    this.ledger?.remove(run.chatId);
    if (run.sessionId && !run.detached) {
      this.wakeable.delete(run.sessionId);
      this.wakeable.set(run.sessionId, {
        chatId: run.chatId,
        options: run.options,
        meta: run.meta,
      });
      for (const key of this.wakeable.keys()) {
        if (this.wakeable.size <= MAX_RETIRED) break;
        this.wakeable.delete(key);
      }
    }

    // Продолжение в чистой сессии — ДО закрытия слушателей: событие о новом
    // разговоре должно уйти живой вкладке, а не только в буфер. Планировщик
    // чужой, поэтому его падение не имеет права утащить завершение прогона:
    // без этого исключение оставило бы слушателей открытыми навсегда.
    //
    // У усыновлённого прогона потока не было, но ответ агента никуда не делся —
    // он в транскрипте Claude Code, который лента и так читает. Берём оттуда
    // ПОСЛЕДНИЙ ЗАВЕРШЁННЫЙ ход: по нему решаются продолжение в чистой сессии,
    // разбор уровня 1, план группы и ревью по ссылке — всё это панель раньше
    // выбрасывала разом. Недописанный транскрипт закрывающего хода не даёт
    // (`readLastAssistantTurn`), и тогда молчим, как и раньше. Дважды применить
    // решение перезапуск не даёт: одноразовость держат отметки конвейера
    // (`reviewedAt`/`plannedAt`), а `finish` у прогона случается один раз.
    // Вопрос инструментом у усыновлённого тоже из транскрипта: событие потока,
    // которым его отмечает живой прогон, умерло вместе с прежним сервером.
    // Живой прогон с ответом длиннее хвоста — тоже из транскрипта (находка 24):
    // разбор ответил 49 661 символом с блоком в начале, хвост потока его срезал,
    // и план групп пропал молча. Закрывающий ход приходит целиком; нет его —
    // остаётся хвост, как раньше.
    const clipped = !run.detached && run.text.length >= TEXT_TAIL;
    const closing = run.detached || clipped ? this.closingTurnOf(run) : undefined;
    const text = run.detached ? (closing?.text ?? '') : (closing?.text ?? run.text);
    // Закрывающий ход из транскрипта — уже итог; иначе — текст после последнего инструмента.
    const answer = closing?.text ?? run.answer ?? '';
    // Итог до первого замечания хука Stop: живой поток знает его сам, усыновлённый — из транскрипта.
    const summary = run.summary?.trim() ? run.summary : (closing?.summary ?? '');
    const asked = run.asked || Boolean(closing?.asked);
    // Закрывающего хода нет — процесс умер посреди него. Раньше здесь молчали,
    // и группа разделения стояла «работает» навсегда (журнал 39, 110); теперь
    // планировщик узнаёт обрыв и ничего, кроме него, не решает. Усыновлённый без
    // посредника процесс, у которого журнал видел фон, — тоже обрыв (журнал 64):
    // CLI вышел по концу ввода и унёс фоновые задачи, чьих итогов ответ не знает.
    // Процесс живой сессии, ушедший сам с фоном посреди хода, — то же (W3-4c).
    const lostBackground = Boolean(
      (run.detached && (run.ledgerBackground ?? 0) > 0) || run.run.lostBackground,
    );
    // Ход, кончившийся ОШИБКОЙ (лимит подписки и т.п.), — не обрыв: его итог
    // решают ожидание лимита и повтор, а не автопродолжение прямо в тот же
    // лимит (итоговое ревью 25.09, m4).
    const interrupted = Boolean((run.detached && !text && !run.errored) || lostBackground);

    // Журнал сдачи усыновлённому по-прежнему не полагается: проверок панель не
    // видела не потому, что их не было, — их скрыл умерший поток.
    // Работа уехала в новый разговор (или ждёт его старта на паузе) — конец
    // этого хода не итог задачи, и Telegram о нём молчит.
    let handedOver = false;
    if (this.planHandoff) {
      try {
        const event = this.planHandoff({
          chatId: run.chatId,
          sessionId: run.sessionId,
          projectPath: run.meta.projectPath,
          text,
          ...(answer.trim() ? { answer } : {}),
          ...(summary.trim() ? { summary } : {}),
          ok: !run.errored,
          startedAt: run.startedAt,
          options: run.options,
          contextTokens: run.contextTokens,
          ...(asked ? { asked: true } : {}),
          ...(interrupted ? { interrupted: true as const } : {}),
          ...(run.meta.origin ? { origin: run.meta.origin } : {}),
          ...(run.routed ? { routed: true as const } : {}),
          ...(run.routedMap ? { routedMap: run.routedMap } : {}),
          ...(run.meta.local ? { local: true as const } : {}),
          ...(run.toolResults ? { toolResults: run.toolResults } : {}),
          ...(run.lastError ? { error: run.lastError } : {}),
          ...(run.limit ? { limit: run.limit } : {}),
        });
        if (event) this.emit(run, event);
        handedOver = event?.kind === 'handoff' && Boolean(event.chatId) && !event.reason;
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

    this.writeLimitJournal(run, run.finishedAt ?? Date.now());
    this.feedWatch(run.chatId, { kind: 'finish', sessionId: run.sessionId });

    this.notify?.({
      kind: run.errored ? 'error' : 'done',
      chatId: run.chatId,
      projectPath: run.meta.projectPath,
      ...(run.errored && run.lastError ? { errorText: run.lastError } : {}),
      durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt),
      ...(run.errored
        ? {}
        : this.turnFacts(run, { answer, asked, interrupted, continued: handedOver })),
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
   *
   * `startedAt` — ход, к которому относится курсор клиента. Новый ход под тем же
   * ключом нумерует события с нуля, и курсор прошлого хода (`from=40` у хода с
   * десятью событиями) терял его начало и конец: поток закрывался пустым, а
   * телефон переподключался по кругу до «связь потеряна». Ход другой — курсор
   * не его, отдаём ход с начала.
   */
  attach(
    chatId: string,
    askedFromSeq: number,
    subscriber: RunSubscriber,
    startedAt?: number,
  ): (() => void) | undefined {
    // По ключу-синониму тоже: вкладка, узнавшая о прогоне под sessionId, должна
    // суметь подключиться к нему, даже если он зарегистрирован под `new-…`.
    const run = this.runs.get(this.resolveKey(chatId));
    if (!run) return undefined;
    const fromSeq = startedAt !== undefined && startedAt !== run.startedAt ? 0 : askedFromSeq;

    // Клиент ждёт кадры, которых уже нет: говорим об этом, а не молчим о дыре в ленте.
    // Номер сообщения — последний сброшенный: он больше `fromSeq` и меньше любого оставшегося.
    if (run.trimmedSeq > fromSeq) {
      const first = run.seq >= ADOPTED_SEQ_BASE ? ADOPTED_SEQ_BASE : 0;
      const params = { count: String(run.trimmedSeq - Math.max(fromSeq, first)) };
      subscriber.send({
        seq: run.trimmedSeq,
        event: {
          kind: 'notice',
          code: 'eventsTrimmed',
          text: serverText('chat-events-trimmed-notice', params),
          textCode: 'chat-events-trimmed-notice',
          textParams: params,
        },
      });
    }
    for (const buffered of run.events) {
      if (buffered.seq > fromSeq) subscriber.send(buffered);
    }

    if (run.status !== 'running') return undefined;

    run.subscribers.add(subscriber);
    return () => {
      run.subscribers.delete(subscriber);
    };
  }

  /**
   * Остановить прогон: убить процесс и убрать из реестра. Отдаёт исход, а не
   * «да/нет»: `unconfirmed` (процесс жив, номер нечем проверить) булевым читался
   * «остановлено» — пауза дерева записывала живой прогон остановленным, а
   * счётчики «остановлено прогонов» врали (F-145). Каждый вызывающий решает сам.
   */
  stop(chatId: string): StopOutcome {
    return this.halt(chatId);
  }

  /**
   * Вернуть ход в остывшую сессию (R5 ревью П1): идущий новый разговор,
   * начатый правилом остывшей сессии, снимается, и тот же старт идёт старой
   * сессией — человеку полная память группы дороже перезаписи кэша. Только
   * пока новый разговор идёт: законченный уже сделал работу, и повтор того же
   * задания старой сессией сделал бы её дважды. Снимается тихо (`halt`, не
   * «Стоп» человека) — группа не встаёт на паузу.
   */
  keepColdSession(chatId: string): 'started' | 'absent' | 'not_cold' | 'unconfirmed' {
    const run = this.runs.get(this.resolveKey(chatId));
    if (!run || run.status !== 'running') return 'absent';
    const origin = run.coldOrigin;
    if (!origin) return 'not_cold';
    const halted = this.halt(chatId);
    if (halted === 'unconfirmed') return 'unconfirmed';
    return this.start(run.chatId, origin.options, { ...origin.meta, keepSession: true })
      ? 'started'
      : 'absent';
  }

  private halt(chatId: string): StopOutcome {
    // Ключ-синоним: «Остановить» из вкладки, знающей разговор по sessionId,
    // обязано убить процесс, поднятый под временным `new-…`, — иначе кнопка
    // молча отвечала бы «прогона нет», а агент продолжал работать.
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run) return 'absent';
    try {
      if (run.run.stop() === 'unconfirmed') {
        // Процесс жив, а снять его панель не вправе: номер нечем проверить. Прогон
        // и запись журнала остаются — иначе CLI работал бы без присмотра, а
        // человек видел бы «остановлено» (F-145).
        const params = { pid: String(run.run.pid ?? '') };
        this.emit(run, {
          kind: 'notice',
          code: 'stopUnconfirmed',
          text: serverText('chat-stop-unconfirmed-notice', params),
          textCode: 'chat-stop-unconfirmed-notice',
          textParams: params,
        });
        return 'unconfirmed';
      }
    } catch {
      // Убить процесс не вышло (уже умер, отказано в доступе) — но реестр и
      // подписчиков всё равно закрываем: иначе исключение отсюда оставило бы
      // прогон «идущим» навсегда, кнопка «Остановить» больше ничего бы не
      // делала, а `stopAll` при выходе панели споткнулся бы на первом же таком.
    }
    if (run.status === 'running') {
      run.status = 'stopped';
      // Конец прогона в журнал лимита: `finish` остановленного уже не запишет, и в
      // журнале осталась бы запись посреди хода — без хвоста токенов, с `open`.
      this.writeLimitJournal(run, Date.now());
      // Конец хода сторожу: `finish` остановленного прогона уже ничего не скажет.
      this.feedWatch(run.chatId, { kind: 'finish', sessionId: run.sessionId });
    }
    for (const subscriber of run.subscribers) subscriber.close('stopped');
    this.remove(key);
    return 'stopped';
  }

  /** «Стоп» человека: слушатель узнаёт ДО остановки — конец хода застанет паузу. */
  stopByHuman(chatId: string): StopOutcome {
    const key = this.resolveKey(chatId);
    const run = this.runs.get(key);
    if (!run) return 'absent';
    // Ход уже кончился (прогон лишь в буфере после завершения): «Стоп» ничего
    // не остановил, и ставить группу на паузу не за что (итоговое ревью 25.09, m3).
    if (run.status !== 'running') return this.halt(chatId);
    const keys = [...new Set([chatId, key, ...(run.sessionId ? [run.sessionId] : [])])];
    try {
      this.onHumanStop?.(keys);
    } catch {
      // Слушатель чужой: его сбой не имеет права сорвать остановку.
    }
    return this.halt(chatId);
  }

  /** Остановить все прогоны разом. */
  stopAll(): void {
    // Один снимок процессов на всех: N сессий × ~0,8 с синхронного снимка Windows.
    withProcessSnapshot(() => {
      for (const chatId of [...this.runs.keys()]) this.stop(chatId);
    });
  }

  /**
   * Выход сервера — Ctrl+C, SIGTERM сторожа или наблюдателя, штатное завершение.
   * Усыновлённый процесс не наш и живёт: прежний `stopAll` здесь убивал его на
   * каждом штатном выходе (журнал 29, решение W3-4a); запись журнала остаётся —
   * новый сервер усыновит его снова. Гаснет только то, что на трубах сервера не переживёт его и так.
   * Остановить всех — явное действие человека: «Остановить» по каждому прогону.
   */
  detachAll(): void {
    // Журнал лимита пишется посреди прогона не чаще раза в пять минут: замеры
    // последних минут на выходе — на диск, новый сервер (и прогноз R9) их видит.
    this.flushLimitJournal();
    for (const [key, run] of [...this.runs]) {
      if (run.status !== 'running') continue;
      if (run.run.detach && run.detached) run.run.detach();
      else this.stop(key);
    }
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
        ...(run.options.effort ? { effort: run.options.effort } : {}),
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
