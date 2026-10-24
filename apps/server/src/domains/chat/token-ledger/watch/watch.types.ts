import type {
  GroupSignalSeverity,
  GroupWatch,
  GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import type { LearnedDurations } from './check-signature.ts';
import type { ToolErrorKind } from './tool-outcome.ts';

/**
 * Событие сторожа — общий язык живого потока (`stream-events.ts`) и хвоста
 * транскрипта (`transcript-events.ts`). Время `t` — мс эпохи, его ставит
 * источник: в чистых функциях часов нет.
 */
export type WatchEvent =
  /**
   * Начало хода: прогон стартовал (поток) или пришла реплика человека/панели (транскрипт).
   * `fresh` — прогон начал НОВЫЙ разговор (без `--resume`): его первый вызов — первый
   * запрос сессии (R19). Транскрипт этого не знает и флаг не ставит.
   * `prev` и `cause` — у нового разговора группы (R34): последний вызов прошлого
   * разговора группы и почему панель начала новый. Ставит сторож, не поток.
   */
  | {
      kind: 'start';
      t: number;
      fresh?: true;
      prev?: { t: number; ctx: number; model?: string };
      cause?: FreshCause;
    }
  | {
      kind: 'call';
      t: number;
      model?: string;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      output: number;
      /** Вызов субагента: в вес и «живость» идёт, в окно сессии — нет. */
      sidechain?: boolean;
      /**
       * Остаток сверки потока с итогом хода: вес без хозяина (субагенты, которых
       * поток не разложил, внутренние вызовы CLI). В расход группы (R8) идёт, в
       * расход субагентов (R13) — нет: веер без единого запуска был бы выдумкой.
       */
      remainder?: boolean;
    }
  | {
      kind: 'tool';
      t: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Стадия звена в момент вызова (R5, R6) — ставит проводка, не поток. */
      stage?: string;
      sidechain?: boolean;
    }
  | {
      kind: 'toolResult';
      t: number;
      id: string;
      chars: number;
      /** Вызов не уложился в свой срок, мс (R15) — `tool-outcome.ts`. */
      timedOutMs?: number;
      /** Вызов отбит стражем или правом: чей отказ (R18) — `tool-outcome.ts`. */
      denied?: string;
      /** Вызов кончился ошибкой (R24, R29, R30) — `tool-outcome.ts`. */
      isError?: true;
      errorKind?: ToolErrorKind;
      /** Голова ошибки под маской: повтор той же ошибки (R24). */
      errorHead?: string;
    }
  /** Текст ответа модели (не размышление): хвост хода — вопрос текстом (R27), вердикт ревью (R33). */
  | { kind: 'say'; t: number; text: string }
  /** Запрос к модели сорвался и повторяется (`system/api_error`, `api_retry`) — R30. */
  | { kind: 'apiError'; t: number; head: string }
  /** Сжатие окна; `manual` — `/compact` по просьбе, не буря (R3 его не считает). */
  | { kind: 'compact'; t: number; manual?: boolean }
  /** Замер пятичасового окна; `rejected` — лимит исчерпан (R10). */
  | { kind: 'limit'; t: number; utilization?: number; resetsAt?: number; rejected?: boolean }
  /** Вставка CLI в окно (`environment`, `diagnostics`, контекст хуков) — знаки по роду. */
  | { kind: 'insert'; t: number; type: string; chars: number }
  /** Модель пишет текст или думает: сессия жива, хотя ни вызова, ни инструмента нет (R1). */
  | { kind: 'activity'; t: number }
  | { kind: 'end'; t: number };

/**
 * Почему панель начала новый разговор поверх тёплого (R34). Нужные: передача
 * доставке, её эскалация, звено правок, ревью, перепроверка MR, передача по блоку,
 * смена стадии. Не нужные: вводная остывшего разговора, начатая на тёплом кэше,
 * и смена модели на тёплом продолжении — запись окна заново, без которой можно было обойтись.
 */
export type FreshCause =
  | 'escalation'
  | 'deliver'
  | 'fix'
  | 'review'
  | 'recheck'
  | 'handoff'
  | 'stage'
  | 'cold-brief'
  | 'model-switch';

/** Окно, заново записанное новым разговором поверх тёплого (R34); `open` — его первый ход идёт. */
export interface FreshRewrite {
  at: number;
  write: number;
  write1h: number;
  /** Окно прошлого разговора на его последнем вызове — больше этого «заново» не бывает. */
  prevCtx: number;
  model?: string;
  cause: FreshCause;
  open?: true;
}

/**
 * Что правка вносит (R35): путь и отпечатки внесённого — у Edit новый текст целиком,
 * у Write строки файла, у правки командой (`sed -i`) — отпечаток шага.
 */
export interface EditIntent {
  /** Путь для сравнения (`normPath`: на Windows в нижнем регистре). */
  path: string;
  /** Путь как его назвал вызов — в строку сигнала. */
  shown: string;
  kind: 'edit' | 'write' | 'shell';
  sig: string[];
}

/** Коммит сессии (R35): когда и какие правки в нём; сторож переносит его в список группы. */
export interface CommitFact {
  at: number;
  intents: EditIntent[];
}

/** Вызов модели самой сессии в кольце состояния (вызовы субагентов — в расходе группы у сторожа). */
export interface WatchCall {
  t: number;
  ctx: number;
  cacheRead: number;
  cw1h: number;
  cw5m: number;
  out: number;
  model?: string;
  weight: number;
}

export interface OpenTool {
  name: string;
  startedAt: number;
  /** Срок самого вызова (Bash `timeout`); нет — срок по умолчанию инструмента. */
  timeoutMs?: number;
  background?: boolean;
  question?: string;
  /** Что за вызов в строке сигнала: команда под маской, путь или имя инструмента (R14–R16). */
  label?: string;
  /** Перечитывает сохранённый вывод CLI (`tool-results/…`, `hook-toolu_…`) — R14. */
  persisted?: boolean;
  /** Сколько такая команда шла по опыту очереди, мс: дольше — не диво (R16). */
  expectMs?: number;
  /** Команда — проверка (подпись R4 или полный гейт): её длительность решает R21. */
  check?: boolean;
  /** Полный гейт по классификатору `gate-at-end` (скрипт гейта, несколько видов проверок целиком). */
  fullGate?: boolean;
  /** Стадия звена при вызове — в строку тяжёлой проверки (R21). */
  stage?: string;
  /** Подпись входа вызова (команда под маской или вход целиком): тот же ли вызов упал снова (R24). */
  sig?: string;
  /** Отпечаток полной команды без `cd` — сверка одной беды между группами (R23). */
  print?: string;
}

/** Тяжёлая проверка, которая действительно шла (R21): полный гейт, весь набор тестов. */
export interface HeavyCheck {
  /** Начало вызова. */
  at: number;
  /** Конец вызова (ответ пришёл; у фонового — момент ухода в фон). */
  endedAt: number;
  minutes: number;
  label: string;
  stage?: string;
}

/** Состояние одной сессии. Ограничено: кольцо вызовов 200, списки и словари — по своим потолкам. */
export interface WatchState {
  calls: WatchCall[];
  lastEventAt: number;
  /** Ход начался, и первого вызова после него ещё не было — для R2. */
  awaitingFirstCall: boolean;
  lastCallAt?: number;
  /**
   * Последний пинг тёплого кэша сессии (`keep-warm`): кэш освежён без вызова в
   * её транскрипте и потоке. Пауза для R2 считается от него, а молчание для R1 —
   * нет: пинг не работа сессии.
   */
  warmedAt?: number;
  /** Окно первого вызова сессии, если сторож его видел, — база свежего старта. */
  firstCtx?: number;
  /**
   * Чтение кэша последнего вызова сессии. У чужого CLI это след холодного
   * продолжения (R2, `readDrop`): чтение было и упало после паузы.
   */
  lastCacheRead?: number;
  openTools: Record<string, OpenTool>;
  compactions: number[];
  /** Подпись проверки → запуски подряд без правки между. */
  checks: Record<string, { runs: number; lastAt: number; command: string }>;
  /** Путь → чтения подряд без правки этого файла. */
  reads: Record<string, { count: number; lastAt: number }>;
  lastEditAt?: number;
  subagents: Array<{ at: number; description: string; agentType: string; stage?: string }>;
  /**
   * Вызовы навыков (`Skill`): своим списком со своим потолком — в общем списке
   * два десятка навыков вытесняли запуски субагентов, и веер (R13) гас раньше
   * срока. Ревью навыком читает R5 (`agentType: 'skill'`).
   */
  skills: Array<{ at: number; description: string; agentType: string; stage?: string }>;
  insertChars: Record<string, number>;
  writeOps: Array<{ at: number; op: string; stage?: string }>;
  panelReads: Array<{ at: number; path: string }>;
  sleepPolls: Array<{ at: number; command: string }>;
  /** `write1h` — часть записи в часовой кэш: остальное пишется по цене пятиминутного. */
  coldWrites: Array<{
    at: number;
    write: number;
    write1h: number;
    ctx: number;
    gapMs: number;
    base: number;
    /**
     * Чужой CLI: `write` — вход, оплаченный полной ценой вместо чтения кэша
     * (провайдер записи кэша не сообщает), а не запись кэша Claude.
     */
    uncached?: boolean;
  }>;
  rejectedAt?: number;
  rejectedResetsAt?: number;
  endedAt?: number;
  /** Расход субагентов по минутам (R13): вызовы субагента в окно сессии не идут, а их W — сюда. */
  subBurn: Array<{ at: number; weight: number }>;
  /** Ответы инструментов сверх порога R14 (пороги — на свёртке, как у холодных записей). */
  bigResults: Array<{ at: number; chars: number; tool: string; label: string; persisted: boolean }>;
  /** Вызовы, упёршиеся в свой срок (R15); короче двух минут — нарочно короткие пробы, не здесь. */
  timeouts: Array<{ at: number; timeoutMs: number; label: string; print?: string }>;
  /** Отказы стражей и прав (R18). */
  denials: Array<{ at: number; guard: string }>;
  /**
   * Вызовы, уже отложенные человеку (D-n), — инструмент и отпечаток входа. Первая
   * постановка — законное ожидание, не отказ R18; повтор того же вызова — стена.
   */
  deferredCalls?: string[];
  /** Разговор начат этим прогоном с нуля, первого вызова ещё не было (R19). */
  fresh?: boolean;
  /** Когда был первый вызов НОВОГО разговора, увиденный сторожем сам (R19). */
  firstCallAt?: number;
  /**
   * Действия сессии — начало хода и вызовы инструментов (свои и субагентов), время.
   * На паузе группы их быть не должно (R20): 23.10 разбуженная на паузе сессия
   * закоммитила и завела worktree, а сторож молчал. `start` — начало хода: оно
   * назначает начало сигнала, но вызовом не считается.
   */
  actions: Array<{ at: number; start?: true }>;
  /** Что за вызов был последним действием — в строку R20. */
  lastActionLabel?: string;
  /** Тяжёлые проверки сессии (R21): сторож переносит их в список группы. */
  heavyChecks: HeavyCheck[];
  /**
   * Вызовы, ждущие ответа, чтобы стать поводом: публикация (R6) и защищённое действие
   * (R25) — по id вызова, субагентов тоже. Отбитый вызов не исполнен — не повод (C17).
   */
  pendingOps: Record<string, PendingOp>;
  /** Подпись «вызов + ошибка» → падения подряд без правки между (R24). */
  errors: Record<string, ErrorRun>;
  /** Отбитые защищённые действия (R25): что за действие и какая команда. */
  deniedOps: Array<{ at: number; op: string; text: string; subject: string }>;
  /** Отбитое действие исполнено другой командой (R25). */
  bypasses: Array<{ at: number; op: string; command: string; afterMs: number }>;
  /** Остановка чужих процессов (R26): цель — имя, порт или PID из поиска по порту. */
  kills: Array<{ at: number; target: string; command: string }>;
  /** Порты, которые сессия подняла сама (`--port N`, `PORT=N`), — их остановка своя (R26). */
  ownPorts: number[];
  /** Файлы, которые сессия запускала сама (`node x/L6-live.mjs` → `l6-live.mjs`): их остановка по образцу своя (R26). */
  ownLaunches: string[];
  /** Порты из поиска по порту прошлого вызова Bash (`netstat`, `lsof`): PID для `kill` оттуда (R26). */
  lookupPorts?: number[];
  /** То же у субагентов: их вызовы идут вперемешку с вызовами сессии, слот свой (F-108). */
  sidechainLookupPorts?: number[];
  /** Правки вне своей копии (R31): путь. */
  outsideWrites: Array<{ at: number; path: string }>;
  /** Служебные вставки CLI по минутам (R32): знаки по роду. */
  inserts: Array<{ at: number; chars: number; byType: Record<string, number> }>;
  /** Сбои связи: запрос к модели или вызов MCP/веба не получил ответа (R30). */
  outages: Array<{ at: number; service: string; head: string }>;
  /** Вызовы инструмента, которого нет в сессии (R29). */
  missingTools: Array<{ at: number; tool: string; stage?: string; forge: boolean }>;
  /** Текст ответа текущего хода (хвост до 2000 знаков) — R27, R33. */
  tail: string;
  /** Текст, которым кончился последний ход, и когда (R27, R33). */
  endText?: string;
  /** Нынешний ход писал блок вердикта ревью (R33); начало хода его снимает. */
  reviewFenceSeen?: boolean;
  /** Новые разговоры поверх тёплого и смены модели на тёплом продолжении (R34). */
  freshRewrites: FreshRewrite[];
  /** Правки с прошлого коммита сессии (R35): коммит переносит их в `commitFacts`. */
  editIntents: EditIntent[];
  /** Что подготовлено к коммиту (`git add`): `all` — всё дерево; нет — неизвестно, коммит берёт все правки. */
  staged?: string[] | 'all';
  /** Вызовы `git commit`, ждущие ответа: id → какие пути коммит берёт. */
  pendingCommits: Record<string, { paths: string[] | 'all' | undefined }>;
  /** Состоявшиеся коммиты сессии, ещё не перенесённые сторожем в список группы (R35). */
  commitFacts: CommitFact[];
}

/** Вызов, ждущий ответа: публикация (R6) и/или защищённое действие (R25). */
export interface PendingOp {
  at: number;
  /** Пуш или MR — публикация для R6. */
  publish?: 'push' | 'mr';
  stage?: string;
  /**
   * Защищённое действие (R25), текст команды без комментариев оболочки и предмет
   * действия (`op-subject.ts`): исправленный повтор — другой предмет, не обход.
   */
  guarded?: { op: string; text: string; subject: string };
}

/** Серия одинаковых падений одного вызова (R24): времена падений (последние 10), что за вызов и ошибка. */
export interface ErrorRun {
  ats: number[];
  lastAt: number;
  label: string;
  head: string;
  /** Отпечаток полной команды (R23). */
  print?: string;
}

/** Что сторож знает о звене в момент оценки — из хранилища разделения, не из потока. */
export interface WatchNode {
  chatId: string;
  groupIndex: number;
  stage?: string;
  running: boolean;
  paused: boolean;
  /** Когда группу поставили на паузу (мс эпохи): действия позже — R20. */
  pausedAt?: number;
  /** Открытый вопрос человеку: с какого момента и текст (R1b). */
  ask?: { since: number; question?: string };
  /** У сессии живая аренда очереди тяжёлых шагов — долгая проверка, не зависание. */
  heavyLease?: boolean;
  /**
   * Сессия ждёт места в очереди тяжёлых шагов: с какого момента, сколько чужих
   * впереди, какая команда (под маской). Не зависание (R1 молчит), но долгое
   * ожидание — своя задержка (R17).
   */
  heavyWait?: { since: number; ahead: number; command?: string };
  /** Звено доставки группы ещё впереди: пуш и MR — его работа (R6). */
  deliverAhead?: boolean;
  /**
   * Вопрос текстом в конце хода некому подхватить (R27): у группы продолжение по
   * ожиданию исчерпало попытки или вопросы группы не «по плану», у одиночного чата —
   * включена автономия. Ставит проводка; нет — R27 молчит: там вопрос читает человек.
   */
  proseWait?: boolean;
  /** Начало звена (мс, `ChatLink.stageSince`): коммиты раньше — работа прошлой стадии (R35). */
  stageSince?: number;
}

/** Где оценивается сессия: звено группы разделения или одиночный чат панели. */
export type WatchScope = 'group' | 'chat';

/** Условие правила сейчас: активно ли, числа и подстановки строки. */
export interface RuleHit {
  rule: GroupWatchRule;
  /**
   * Важность сигнала: базовая из `GROUP_WATCH_SEVERITY`, если правило не подняло её
   * само (вопрос висит дольше `askAlertMinutes` — тревога).
   */
  severity: GroupSignalSeverity;
  numbers: Record<string, number>;
  params?: Record<string, string>;
  /** Когда условие возникло (для поля `at` сигнала). */
  since: number;
}

/** Окружение оценки: пороги, корень панели (R7), каталог копии. */
export interface WatchContext {
  settings: GroupWatch;
  /** Корень репозитория самой панели: чтение оттуда из копии — R7. */
  panelRoot?: string;
  /** Каталог, в котором идёт звено (копия): чтения внутри неё — свои, относительные пути — от него. */
  cwd?: string;
  /** Домашний каталог: `~/…` в команде (R7). */
  home?: string;
  /** Короткое имя 8.3 → полное, если путь существует; нет — `undefined` (шов диска, R7). */
  realPath?: (path: string) => string | undefined;
  /** Опыт длительностей очереди тяжёлых шагов: долгий скрипт — тоже проверка (R4). */
  learned?: LearnedDurations;
  /**
   * Как у сессии чужого CLI остывает кэш (R2). Нет — сессия Claude: срок и
   * размер из настроек сторожа, след — запись кэша.
   */
  cold?: ColdCacheRule;
  /**
   * Слушает ли порт на этой машине (R36) — по последней пробе соединения; проба идёт
   * мимо правил (`port-probe.ts`). Нет — R36 молчит.
   */
  portAlive?: (port: number) => boolean;
}

/**
 * Холодное продолжение у чужого CLI (R2). `off` — сигнала нет вовсе: локальная
 * модель кэша провайдера не платит, а CLI без известного формата переписки не
 * даёт следа. `readDrop` — кэш провайдера остывает за `afterMs` (свой срок, не
 * часовой Claude), а записи кэша провайдер не сообщает: след — чтение кэша,
 * упавшее после паузы, когда до неё кэш читался.
 */
export type ColdCacheRule = { kind: 'off' } | { kind: 'readDrop'; afterMs: number };
