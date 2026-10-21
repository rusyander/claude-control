/**
 * Разбор расхода одной сессии агента: куда ушло окно лимитов. Цифры — те, по
 * которым идёт план экономии: расход ≈ вызовы × (постоянная часть +
 * накопленное) + запись + вывод. Поэтому отчёт несёт каждое слагаемое отдельно.
 */

/** Токены одного вызова модели — ровно поля `usage` транскрипта Claude. */
export interface CallTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Часть записи со сроком в час: по ней видно, сколько стоит выбор срока кеша. */
  cacheWrite1h: number;
  output: number;
}

/** Вызов модели с тем, что он сделал. */
export interface AuditCall extends CallTokens {
  /** Контекст вызова: вход + чтение кеша + запись. */
  context: number;
  timestamp?: string;
  /** Класс шага по его инструментам (`shots`, `gate`, `read`…). */
  step: string;
}

/** Состав постоянной части — то, что приходит до первого ответа модели. */
export interface ConstantPart {
  /** Контекст первого вызова, токены. */
  firstContext: number;
  /** Первая реплика человека (у группы — её задание), знаки. */
  taskChars: number;
  /** Файлы инструкций (CLAUDE.md, правила, память): путь → знаки. */
  instructions: Array<{ path: string; chars: number }>;
  /** Список навыков: знаки и число. */
  skillChars: number;
  skillCount: number;
  /** Отложенные инструменты: всего и по источнику (`mcp:<сервер>`, `builtin`). */
  deferredTools: number;
  deferredBySource: Record<string, number>;
  /** Указания MCP-серверов и список агентов, знаки. */
  mcpInstructionChars: number;
  agentListingChars: number;
}

export interface SpikeInfo {
  timestamp?: string;
  write: number;
  /** Пауза перед вызовом, минуты: долгая пауза = остывший кеш. */
  gapMinutes: number;
  /** Что случилось перед всплеском: `compact`, `user`, `hook`… */
  causes: string[];
}

/** Время по транскрипту (мс от эпохи и длительности); `busy` — отрезки занятости. */
export interface SessionTime {
  firstMs: number;
  lastMs: number;
  /** Модель пишет ответ. */
  modelMs: number;
  /** Идут инструменты (параллельные вызовы складываются). */
  toolMs: number;
  busy: Array<[number, number]>;
}

/** Метрики плана экономии окна: каждая — след своей меры (`economy.ts`). */
export interface EconomyMetrics {
  /** Доля прочитанного контекста, которую занимает постоянная часть, %. */
  prefixShare: number;
  /** Проверки одного рода на весь проект посреди работы: прогоны и минуты. */
  wholeChecks: { runs: number; minutes: number };
  /** Команды, убитые по таймауту: число и минуты до убийства. */
  capKills: { count: number; minutes: number };
  /** Минуты в `sleep`. */
  sleepMinutes: number;
  /** Доля вызовов с одним инструментом подряд за таким же, %. */
  singleRunShare: number;
  /** Блоки правил, пришедшие на черновик (temp, scratchpad, `.agent/`) или тело heredoc. */
  falseRules: number;
}

export interface SessionAudit {
  id: string;
  /** `claude` / `codex` / `qwen`: у чужих CLI нет хуков и вложений — их поля пусты. */
  kind: 'claude' | 'codex' | 'qwen';
  title?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  calls: number;
  totals: CallTokens;
  /** Вес вызовов сессии в окне подписки, W (`window-weight.ts`); у чужих CLI нет. */
  weight?: number;
  models: Record<string, number>;
  constant?: ConstantPart;
  averageContext: number;
  maxContext: number;
  compactions: number;
  /** Класс шага → вызовы и доля чтения кеша (0..1). */
  steps: Record<string, { calls: number; cacheRead: number }>;
  /** Инструмент → вызовы, знаки ответа, ошибки. */
  tools: Record<string, { calls: number; resultChars: number; errors: number }>;
  /** Текст, подмешанный хуками: имя хука → знаки. */
  hookContext: Record<string, number>;
  /** Отказы хуков: метка отказа → число. */
  hookDenials: Record<string, number>;
  /** Ответы, выгруженные CLI в файл (`<persisted-output>`). */
  spills: number;
  /** Файлы, открытые два и больше раз; `unchanged` — повторы без правки между ними. */
  rereads: { files: number; unchanged: number; top: Array<{ path: string; views: number }> };
  /** Одинаковые команды Bash, запущенные повторно. */
  repeatedBash: number;
  /** Вызовы, где весь шаг — одна короткая команда Bash, и их доля чтения кеша. */
  tinyBash: { calls: number; cacheRead: number };
  /** Ожидания: `sleep`, циклы опроса. */
  pollCommands: number;
  /** Вывод: знаки текста, входов инструментов и записей файлов целиком. */
  outputChars: { text: number; toolInput: number; wholeFileWrites: number; wholeFileChars: number };
  images: number;
  cacheWriteSpikes: SpikeInfo[];
  /** Вложенные агенты (ревьюеры, разведчики) этой сессии. */
  subagents: SessionAudit[];
  /** Время по часам и занятость; у журналов Codex/Qwen нет. */
  time?: SessionTime;
  /** Метрики плана экономии; у журналов Codex/Qwen нет. */
  economy?: EconomyMetrics;
}
