import type {
  AdapterCaps,
  AdapterChannelSummary,
  Dialect,
  RefusalCode,
} from '@agentdeck/contracts/core/routes';
import type {
  SendOrigin,
  SkillMode,
  UserLayerInventory,
} from '@agentdeck/contracts/core/user-layer';
import type { AgentEndHow, BgEndHow, BgKind } from '@agentdeck/contracts/core/agents';
import type { SendImage } from '@agentdeck/contracts/core/ask';
import type {
  LocalLayerCarry,
  SessionHooks,
  SettingSource,
} from '@agentdeck/contracts/core/session-carry';
import type { Identity } from '../session-host/protocol.ts';
import type {
  CoreSessionVars,
  EnvLayers,
  SpawnedFacts,
  StopMode,
  StopOutcome,
} from './launcher/launcher.types.ts';

/**
 * Интерфейс переходника CLI (03 §CLI adapter). Возможности (`AdapterCaps`) — из шва контрактов
 * (`@agentdeck/contracts/core/routes`), их здесь не переопределяем. Остальное — описание сеанса,
 * события и вопрос о праве — принадлежит слою переходников: шов их не объявляет, а части ядра
 * получают переходник только через реестр (`adapters/index.ts`).
 */

export type { AdapterCaps, AdapterChannelSummary };

/** Пределы локальной модели (11 R:PR-04): окно, срок ответа, срок тишины потока. */
export interface LocalLimits {
  windowTokens: number;
  timeoutMs: number;
  idleMs: number;
}

/** Адрес маршрута, уже разрешённый пускателем: ключ — значение заглушки или ключа на один сеанс. */
export interface BoundEndpoint {
  /** Origin без пути (шов v2): путь диалекта добавляет привязка. */
  baseUrl: string;
  dialect: Dialect;
  model: string;
  key: string;
}

/** Привязка адреса к ОДНОМУ сеансу: окружение, argv и свои файлы рядом (никогда не файл человека). */
export interface EndpointBinding {
  env: Record<string, string>;
  argv: string[];
  /** Файлы сеанса: путь относительно каталога сеанса → текст. */
  files: Record<string, string>;
}

export type BindOutcome = { ok: true; binding: EndpointBinding } | { ok: false; code: RefusalCode };

/**
 * Запреты платформы типами (06 §Session permissions): каждый переходник переводит их в свою
 * форму (Claude — `permissions.deny` + `--disallowedTools`, Qwen — системные настройки +
 * `--exclude-tools`). Запрет бьёт любое разрешение человека.
 */
export interface DenySet {
  /** Пути, которые нельзя ни читать, ни править (дом ядра, файлы токенов). */
  paths: string[];
  /** Пути, которые нельзя править (служебный каталог git копии); чтение не запрещено. */
  editPaths?: string[];
  /** Префиксы argv команд (`['git','push']`). */
  commands: string[][];
  /** Инструменты MCP по полному имени (`mcp__<server>__<tool>`). */
  mcpTools: string[];
  /**
   * Серверы MCP человека, которые правило `forge-mcp-read-only` держит только на чтении (P82):
   * их инструменты до сеанса не перечислены — имя судят хук ядра и сервер права в момент вызова.
   */
  forgeMcpServers?: string[];
  /** Встроенные инструменты CLI классом в словаре ядра; имя у каждого CLI своё. */
  tools: CoreToolClass[];
}

export type CoreToolClass = 'write' | 'edit' | 'shell' | 'web';

/**
 * Факты платформы для запретов КАЖДОГО сеанса (`deny-overlay.ts`): каркас переходника вливает
 * их в `deny` шага до плана запуска — без них сеанс не собирается.
 */
export interface PlatformDenyFacts {
  /** Корень дома ядра (журналы, профили, токен ядра) — ни чтения, ни правки. */
  coreHome: string;
  /** Файлы токенов вне дома ядра (токен панели, хранилище ключей форджа). */
  tokenFiles: readonly string[];
  /**
   * Очередь машины вне дома ядра (`allocator-wiring/machine.ts`: места сеансов, факты окна всех
   * ядер) — ни чтения, ни правки: подложенный факт окна ставит отсрочку всей машине, мусорное или
   * удалённое место останавливает выдачу либо отдаёт чужое место.
   */
  machineQueue?: string;
  /** Инструменты записи форджа по полному имени MCP (маски `mcp__<server>__*` допустимы). */
  forgeMcpTools?: readonly string[];
  /** Серверы MCP человека шага, говорящие с форжем (`adapters/forge/mcp-tools.ts`): только чтение. */
  forgeMcpServers?: readonly string[];
}

/** Сервер MCP на stdio, как его запускает CLI. */
export interface McpStdioEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Каталог запуска сервера (сервер человека, где его конфиг CLI называет `cwd`). */
  cwd?: string;
  url?: never;
}

/**
 * Удалённый сервер MCP (s10 p8): `http` — streamable HTTP, `sse` — старый SSE. Заголовки уже с
 * подставленными значениями (секреты — в книге ключей, в журнал — только имена).
 */
export interface McpRemoteEntry {
  url: string;
  transport: 'http' | 'sse';
  headers?: Record<string, string>;
  command?: never;
}

/** Сервер шага; различение и значения секретов — `mcp-carry.ts` (модуль типов значений не несёт, F-96). */
export type McpServerEntry = McpStdioEntry | McpRemoteEntry;

/** Слой человека в сеансе (06 §User layer, P87). */
export type LayerMode = 'on' | 'observe' | 'off';

/**
 * Доверие к репозиторию, с которого снята копия (03 §Layer control, F-86). Отметка ставится на
 * путь ИСХОДНОГО репозитория, не одноразовой копии: по нему CLI хранит своё доверие к папке.
 */
export interface RepoTrust {
  /** Путь исходного репозитория (`task.created.repos[].path`). */
  sourceRepo: string;
  /** Отметка панели: человек доверил этот репозиторий в панели (ядро берёт её из своего конфига). */
  panelMark: boolean;
}

/** Что читатель MCP человека знает о сеансе: пин окружения задачи, каталог сеанса, доверие. */
export interface McpSourceInput {
  /** Закреплённое окружение задачи: дом человека и переменные дома CLI (`CODEX_HOME`, …). */
  pin: Record<string, string>;
  /** Каталог сеанса (копия): отсюда CLI искал бы файлы проекта. */
  cwd: string;
  /** Доверие к исходному репозиторию (F-86); нет или не доверен — файлы проекта не читаются. */
  trust?: RepoTrust;
}

/** Сервер MCP человека, как его собрал бы сам CLI из своих файлов. */
export interface HumanMcpServer {
  id: string;
  /** Чей файл дал последнюю запись сервера: пользователя или проекта. */
  scope: 'user' | 'project';
  /** Файл последней записи по порядку CLI. */
  file: string;
  /** Запуск сервера; нет — сервер не переносится, причина в `skipped`. */
  entry?: McpServerEntry;
  skipped?: string;
}

/** Серверы MCP человека из конфига CLI (P73, s10 p7): предложения строгого списка шага. */
export interface McpSourceRead {
  /** Включённые серверы, по имени; выключенные (`enabled: false`) CLI не запустил бы — их нет. */
  servers: HumanMcpServer[];
  /** Файл есть, но не разобран — назван, не «пусто». */
  unread: { file: string; reason: string }[];
  /** Почему файлы проекта не читались (нет доверия); читались — нет поля. */
  projectSkipped?: string;
}

/**
 * Чьё доверие открыло слой репозитория: отметка панели, запись самого CLI, никакой (`none`) или
 * запись не прочлась (`unknown`, F25: «не знаю» не читается как «да»).
 */
export type TrustSource = 'panel' | 'cli' | 'none' | 'unknown';

/**
 * Слой, с которым сеанс запущен на деле (F-86): недоверенная копия, запрошенная в `on`, идёт в
 * `observe` (или в безопасном режиме самого CLI) — журнал показывает понижение и причину.
 */
export interface LayerRun {
  asked: LayerMode;
  ran: LayerMode;
  /**
   * Файлы настроек репозитория (хуки, `env`, MCP, права проекта) дошли до сеанса; `false` — из них
   * дошёл только `deny`, данными в настройках ядра (у Qwen ещё ключи, чьё действие держит ядро,
   * `qwen/repo-layer.ts`; прочее — отказ запуска).
   */
  repoLayer: boolean;
  trust: TrustSource;
  /**
   * Почему доверия нет: какая запись не прочлась или чего в ней не нашлось; у недоверенной копии
   * ещё — сколько запретов репозитория дошло данными и какие сняты (закрыли бы инструменты ядра).
   */
  detail?: string;
  /**
   * Части слоя человека, которые до сеанса не дошли (G-b): по одной на строку, без префикса. Дорога
   * пишет каждую сигналом `layer-loss`; нет поля — потерь нет. Отдельным полем, а не текстом в
   * `detail`: разбор строки по префиксу молча терял бы потерю, чей текст сменил форму.
   */
  losses?: string[];
}

/**
 * Какие встроенные инструменты получает шаг (P73): ревью — только чтение. `none` — ни одного
 * (вопрос «ask», этап 10 F2): только серверы MCP, которые дала дорога. Переходник, не умеющий
 * снять встроенные инструменты целиком, `none` не получает — дорога отказывает до запуска.
 */
export type ToolSet = 'all' | 'read-only' | 'none';

/**
 * Сужения и плагины сеанса от вызывающего (`task.created.session`, G6, контракт `session-carry`):
 * `settingSources` — CLI грузит не больше этих источников настроек; `plugins` — каталоги плагинов
 * на один сеанс (набор панели); `builtinTools` — встроенные инструменты не шире списка.
 */
export interface SessionLayerCarry {
  settingSources?: readonly SettingSource[];
  plugins?: readonly string[];
  builtinTools?: readonly string[];
  /** Промпт контура вместо системного промпта CLI (s10 G13 p7); бриф ядра — после него. */
  systemPrompt?: string;
  /** Локальный слой проекта вместо источника `project` (s10 G14 p6, `LocalLayerCarry`). */
  localLayer?: LocalLayerCarry;
  /** Хуки профиля чата панели (s12, `session.hooks`): в `--settings` ядра, хук ядра — последним. */
  hooks?: SessionHooks;
}

/**
 * Как сеанс запущен на деле — для описи слоя (`inventory`): в `on` CLI исполняет хуки сам, и не
 * только из файлов настроек — плагины набора панели (`carry.plugins`, `--plugin-dir`), локальный
 * слой, включённые плагины человека; источники настроек сужены `sources` / `carry.settingSources`.
 * Нет поля — опись слоя человека как есть (оценка, ключ замера), без того, что даёт сеанс.
 */
export interface InventorySession {
  ran: LayerMode;
  sources?: 'user';
  carry?: SessionLayerCarry;
}

export interface SessionSpec {
  sessionId: string;
  /** Каталог сеанса в доме ядра. */
  dir: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Первый бриф — системным промптом (P88). */
  brief: string;
  /**
   * Разговор CLI, который продолжаем; дельта возобновления — отдельным сообщением ядра. `from` —
   * каталог прежней сессии ядра, чей разговор продолжается (решение `continuation`): переходник со
   * своим домом у каждого сеанса берёт транскрипт оттуда. Нет `from` — разговор начат не ядром
   * (оценка `resume`), транскрипт — в хранилище человека, уже подтверждённый `ownsTranscript`.
   */
  resume?: { conversationId: string; from?: string };
  endpoint?: { channel: AdapterChannelSummary; endpoint: BoundEndpoint };
  limits?: LocalLimits;
  /** Запреты ШАГА; запреты платформы (`platform`) каркас добавляет сам, снять их шаг не может. */
  deny: DenySet;
  platform: PlatformDenyFacts;
  tools: ToolSet;
  /**
   * Хук ядра PreToolUse: готовая строка команды (`"<node>" "<script>"`). Спека 03 и P81 требуют
   * его в каждом режиме: Claude без него сеанс не запускает (F-10), кроме переходника, явно
   * собранного для тестов без хука.
   */
  coreHook?: string;
  /** Серверы MCP шага: строгий список, собранный ядром (свои + человека без форджа). */
  mcpServers: Record<string, McpServerEntry>;
  /**
   * На вопросы о праве отвечает ядро (сервер `agentdeck-permit`); нет — вопросы отказываются
   * сразу (fail-closed). CLI, который спрашивает строкой протокола, а не инструментом, сервер
   * не запускает: его вопросы приходят событием `permit.request`.
   */
  permitServer?: { name: string; tool: string };
  /**
   * `skills` — навыки человека (06:115): шаг сценария называет режим всегда (дорога берёт его из
   * `userLayer` шага), умолчания в переходнике нет — иначе «не спросили» и «включены» совпали бы.
   */
  layer: {
    hooks: LayerMode;
    skills: SkillMode;
    /**
     * `user` — CLI грузит только источник человека (этап 10, F6, песочница): ни слоя проекта,
     * ни инструкций предков рабочей папки — песочница под домом человека иначе подхватила бы его
     * настоящие `CLAUDE.md`. Доверие к папке тогда не читается: слоя проекта нет вовсе. Только
     * переходник с `userSourcesOnly`; прочим дорога отказывает. Нет поля — источники по режиму.
     */
    sources?: 'user';
    /**
     * Сужения и плагины вызывающего (`task.created.session`, G6). Каждое поле — только у
     * переходника с тем же полем в `sessionCarry`; прочим дорога отказывает до запуска, а не
     * запускает без них. Нет поля — сеанс как решил шаг.
     */
    carry?: SessionLayerCarry;
  };
  /**
   * Исходный репозиторий копии и отметка панели (F-86). Нет поля — источник неизвестен, копия
   * недоверенная: слой репозитория до сеанса не доходит, `on` идёт как `observe`.
   */
  trust?: RepoTrust;
  /** Команды хуков человека, которые `observe` оборачивает записью (переходник читает их сам). */
  env: EnvLayers;
  core: CoreSessionVars;
  /** Запись хуков в режиме `observe`: куда писать вызовы и чем. */
  recorder?: { command: string; log: string };
  /** Рычаги экономии шага (`config.economy`, s10 p8; чат их не получает); нет — решает CLI. */
  economy?: SessionEconomy;
  /**
   * Сеанс без следа (замер базы): разговор CLI не ложится в хранилище человека — иначе проба
   * встаёт строкой «AGENTDECK_BASE_PROBE …» в списке чатов панели. Как — `CliAdapter.ephemeral`.
   */
  ephemeral?: true;
}

/**
 * Рычаги экономии шага (s10 p8, порт рычагов групп панели): ноль/нет — «не трогать, решает CLI».
 * Каждый CLI несёт их своим ключом (`economy-carry.ts`) или называет потерю.
 */
export interface SessionEconomy {
  /** Окно автосжатия, токены. */
  compactWindow?: number;
  /** Потолок ответа оболочки в окне, знаки. */
  bashOutputChars?: number;
  /** Потолок одного чтения файла, токены. */
  readOutputTokens?: number;
  /** Срок кэша подсказки; нет — решает CLI. */
  cacheTtl?: '5m' | '1h';
  /** Не подключать сеанс к IDE человека. */
  detachIde?: boolean;
  /** Строка привычек в правилах платформы брифа (+ без напоминания «молчит» у Claude). */
  workHabits?: boolean;
  /** Окно модели шага, токены (доля сжатия у Goose/Qwen); нет — неизвестно. */
  modelWindow?: number;
}

export interface SessionHandle {
  sessionId: string;
  dir: string;
  host: Identity;
  child: Identity;
  spawned: SpawnedFacts;
}

/**
 * Типизированный вопрос о праве (06): текст команды — только для показа. `conversation` —
 * инструмент, который трогает только состояние разговора самого CLI (загрузка отложенных
 * инструментов, список дел). `skill` — навык человека, `subagent` — подагент CLI (06:115, 06:124):
 * судья пускает их только по фактам слоя (`PermitContext.layer` / `subagents`), без фактов —
 * отказ, как прежде у `other`.
 */
export interface PermissionAsk {
  action:
    'read' | 'edit' | 'exec' | 'net' | 'mcp' | 'conversation' | 'skill' | 'subagent' | 'other';
  /** Путь, argv[0..], имя инструмента MCP, имя навыка или тип подагента, адрес. */
  target: string;
  /** `subagent`: модель, которую просит вызов (`null` — наследует модель сеанса). */
  model?: string | null;
  argv?: string[];
  /**
   * `exec`: argv дословно тот, что исполнит оболочка (нет экранирования, раскрытий `$…`/`` `…` ``,
   * шаблонов, скобок, перенаправлений). `false` — разбор мог разойтись с оболочкой (`gi\t push`):
   * судья argv не верит и решает fail-closed (F-02). Нет поля — переходник этого не знает.
   */
  argvExact?: boolean;
  /**
   * `read`: диапазон чтения (`offset`/`limit` инструмента); `null` — файл целиком; нет поля —
   * переходник диапазон не читает (этап 8, предикаты перечитывания и большого чтения).
   */
  range?: { offset: number | null; limit: number | null } | null;
  tool: string;
  display: string;
}

/**
 * Исход вызова инструмента (этап 8, F18): только из структурного поля CLI, никогда из текста модели.
 * `null` — CLI факт не отдал.
 */
export interface ToolOutcome {
  exitCode: number | null;
  /** Замаскированное начало текста ошибки, не длиннее 2 КБ. */
  errorText: string | null;
  bytes: number | null;
}

export type TurnCause = 'notification' | 'background-wake' | 'late-tail';

/**
 * Как ход привязан к нашей отправке (правило переходника, R:S2-04): `echo` — CLI вернул наш
 * uuid (повтор сообщения или жизненный цикл команды), `sequence` — эха нет, ядро отправляет по
 * одной и берёт следующий начавшийся ход.
 */
export type TurnOrigin = 'echo' | 'sequence';

export type AdapterEvent =
  | {
      type: 'init';
      conversationId: string;
      model: string;
      tools: string[];
      mcp: { name: string; status: string }[];
    }
  | { type: 'turn.started'; attribution: string; origin: TurnOrigin }
  | {
      type: 'turn.ended';
      attribution: string;
      origin: TurnOrigin;
      isError: boolean;
      numTurns: number;
      text: string;
    }
  | { type: 'turn.cli-initiated'; cause: TurnCause; numTurns: number }
  | {
      type: 'tool.requested';
      toolUseId: string;
      name: string;
      input: unknown;
      cliInitiated: boolean;
      /**
       * Вызов внутри подагента: id вызова-родителя (`Task`), у подагента свой контекст (этап 8,
       * R11). `null` — главный контекст; нет поля — переходник этого ещё не знает.
       */
      parentToolUseId?: string | null;
    }
  | {
      type: 'tool.result';
      toolUseId: string;
      isError: boolean;
      cliInitiated: boolean;
      /** Исход вызова из структурного поля CLI (этап 8, F18); нет поля — переходник его не читает. */
      outcome?: ToolOutcome;
    }
  | { type: 'text.delta'; text: string }
  | ({ type: 'usage' } & TurnUsage)
  /**
   * Факт окна подписки из потока CLI (11 §Economy, `windowEvent: true`): у CLI без
   * задокументированного события его нет — окно `unknown`, отказ читается в потоке (G13).
   */
  | ({ type: 'window' } & WindowObservation)
  /** Вопрос о праве, решённый в самом CLI; `toolUseId` — id вызова, если поток его назвал. */
  | { type: 'ask'; ask: PermissionAsk; denied: boolean; toolUseId?: string }
  /**
   * Вопрос о праве в самом потоке (у CLI нет инструмента-вопроса, он спрашивает строкой
   * протокола и ждёт ответа в stdin): ядро решает по `raw` и отвечает `answerPermit`.
   */
  | { type: 'permit.request'; requestId: string; raw: unknown }
  /**
   * Хук человека отказал вызову (G-e): какой вызов (`null` — поток не назвал), событие хука, сам
   * хук (`null` — CLI его не назвал; тогда кандидаты ищутся в описи по matcher), причина.
   */
  | {
      type: 'hook.refused';
      toolUseId: string | null;
      event: string;
      hook: string | null;
      reason: string;
      cliInitiated: boolean;
    }
  | { type: 'error'; code: AdapterErrorCode; detail: string }
  | AgentSpawnedEvent
  | AgentEndedEvent
  | BgStartedEvent
  | BgEndedEvent;

/**
 * Субагент, запущенный сеансом (этап 11, P146): строка задачи CLI (`task_started`) + вход его
 * вызова (модель, усилие, вводная). `kind: 'other'` — тип задачи, ядру незнакомый, назван в
 * `subagentType`.
 */
export interface AgentSpawnedEvent {
  type: 'agent.spawned';
  cliTaskId: string;
  toolUseId: string;
  parentToolUseId: string | null;
  kind: 'subagent' | 'other';
  subagentType: string | null;
  model: string | null;
  effort: string | null;
  background: boolean;
  depth: number | null;
  /** Вводная как её прислал CLI — без маски и обрезки: их делает запись журнала. */
  brief: string | null;
}

export interface AgentEndedEvent {
  type: 'agent.ended';
  cliTaskId: string;
  toolUseId: string;
  how: AgentEndHow;
  /** Итог CLI (`task_notification.usage`); `null` — не назван. */
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  summary: string | null;
}

/** Фоновая работа сеанса (P148): оболочка, монитор, незнакомый тип (`other`). */
export interface BgStartedEvent {
  type: 'bg.started';
  itemId: string;
  cliTaskId: string | null;
  toolUseId: string;
  parentToolUseId: string | null;
  kind: BgKind;
  /** Команда или описание без маски и обрезки — их делает запись журнала. */
  excerpt: string;
  outputFile?: string;
  pid?: number;
  /**
   * Стена начала, как её назвал поток: время строки, выпустившей начало (результат вызова), или
   * конец задачи, если она кончилась раньше результата. Нет — время записи.
   */
  startedAt?: number;
}

export interface BgEndedEvent {
  type: 'bg.ended';
  itemId: string;
  how: BgEndHow;
  exitCode?: number;
  /** Стена конца, как её назвал CLI (`task_updated.patch.end_time`); нет — время записи. */
  endedAt?: number;
  summary?: string;
}

export type AdapterErrorCode = 'fresh-required' | 'model-error' | 'exited' | 'protocol';

/**
 * Использование одного API-хода (03 `usage(h)`): ПОЛНЫЕ текущие числа хода — повтор того же
 * `messageId` заменяет прежний, а не прибавляется (P43).
 */
export interface TurnUsage {
  messageId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Доля `cacheWrite` с часовым сроком кэша (дороже пятиминутной); нет — 0. */
  cacheWrite1h?: number;
  /** Модель хода, как её назвал поток; нет — модель сеанса. */
  model?: string;
  /** Ход подагента CLI (строка с `parent_tool_use_id`): своей сессии ядра у него нет. */
  subagent?: boolean;
  /**
   * Вызов-родитель хода (P149): строка — ход субагента этого вызова, `null` — главный контекст
   * (строка CLI назвала `parent_tool_use_id: null`); нет поля — поток родителя не назвал.
   */
  parentToolUseId?: string | null;
  /**
   * Остаток хода: итог CLI (`result`) больше суммы сообщений хода — разница одной строкой,
   * чтобы свёртка сошлась с итогом CLI, не удваивая записанное.
   */
  remainder?: boolean;
  /**
   * Окно контекста модели хода, как его назвал CLI (`result.modelUsage.<model>.contextWindow`):
   * первый ход узнаёт его только в `result` и издаётся снова с ним, следующие несут его сразу.
   */
  contextWindow?: number;
}

/**
 * Наблюдение окна подписки: доля (0..100) и сброс самого тесного окна, вид предела по
 * `11 §Economy`. `warning` — CLI предупредил, но обслуживает (P19: держать нечего); `refusal` —
 * отказал на деле.
 */
export interface WindowObservation {
  limitKind: 'window' | 'rate' | 'budget' | 'slot';
  usedPct: number | null;
  /** Стена, мс; `null` — источник сброса не назвал. */
  resetAt: number | null;
  warning: boolean;
  refusal: boolean;
  /** Имя окна у источника (`five_hour`…) — для причины решения, судья его не читает. */
  window: string | null;
  /**
   * Каждое окно источника с долей (имя → доля 0..100 и сброс, мс): замер загрузки для доли
   * лимита у чата панели (`limit-journal`). Судья его не читает; нет окон с долей — поля нет.
   */
  windows?: Record<string, { usedPct: number; resetAt: number | null }>;
}

/** Сырой вызов инструмента, как его видит CLI (для `mapPermission`). */
export interface RawToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Разбор сырого вопроса CLI о праве и ответ в его форме. Форма — факт CLI, поэтому кодек даёт
 * переходник сессии (`CliAdapter.permitCodec`); ядро знает только `toolUseId` и `RawToolCall`.
 * `read` вернул `undefined` — вопрос не разобран, ответ — отказ (P41: без id вызова не доказать,
 * что вопрос отвечает на запрос модели).
 */
export interface PermitCodec {
  read(raw: unknown): { toolUseId: string; call: RawToolCall } | undefined;
  render(
    answer: { allow: true; input: Record<string, unknown> } | { allow: false; message: string },
  ): unknown;
}

/**
 * Слой CLI, который модель читает вне копии (F-87, 06 §Session permissions): каталоги только для
 * чтения (навыки, правила, агенты, команды) и файлы учётных данных, чтение которых судья
 * отказывает. Абсолютные пути с окружением задачи; имена знает переходник (P108).
 */
export interface ReadLayer {
  dirs: string[];
  credentials: string[];
  /**
   * Что CLI переписывает сам во время сессии (кэш, глобальный конфиг, обновление токена): снимок
   * защищённых корней их не сравнивает — иначе каждый шаг ловит сам CLI (P04).
   */
  volatile?: string[];
}

/**
 * Модели от слабой к сильной (имена, которые CLI принимает; понижение ставит их), другие имена
 * той же ступени по индексу (приставки полных id) и усилие от низкого к высокому.
 */
export interface AdapterLadder {
  models: readonly string[];
  aliases: readonly (readonly string[])[];
  efforts: readonly string[];
  /**
   * Потолок автоматики (`CliRunFacts.autoCeiling`): эскалация и подъём по обучению выше этой
   * модели не идут. Нет — модель сама не поднимается, только усилие.
   */
  autoCeiling?: string;
}

export interface CliAdapter {
  id: string;
  /**
   * `false` — заготовка (этап 10, `adapters/placeholder`): id в реестре, запуска нет. Маршрута
   * входа CLI у неё нет, судья compat отказывает `adapter_not_built`. Нет поля — переходник есть.
   */
  built?: false;
  /**
   * `false` — переходник идёт только по маршруту с адресом модели (свой дом конфигурации сеанса):
   * своего входа CLI он не читает (вход человека живёт в его доме), поэтому маршрута
   * `cli-login:<id>` ядро не строит — иначе набор по умолчанию предлагал бы маршрут, который
   * запуск всегда отказывает. Нет поля — вход CLI есть.
   */
  cliLogin?: false;
  /**
   * Имена образа процесса CLI (`claude` → `claude.exe` на Windows): по ним псевдозадача узнаёт
   * предка-CLI проверки из сессии человека (04:41-42, A2-F02). CLI, поставленный через npm, живёт
   * под образом `node` — такой предок не узнаётся, проверка идёт вне очереди и названа.
   */
  images: readonly string[];
  /**
   * Исполняемый файл CLI для вызовов вне сеанса (`--version` замера базы) — тот же, что запустил
   * бы сеанс сейчас (путь `cliPaths` настройки ядра, иначе факты запуска), читается на каждом
   * обращении; нет — переходник такого вызова не знает. Общие части ядра CLI не называют (P108).
   */
  versionCommand?: string;
  /**
   * Лестница уровня шага (03 §Economy) из фактов запуска CLI: понижение механики, ревьюер не
   * слабее автора, ранг модели правки человека и потолок подагента. Нет — ранга модели у CLI не
   * знаем, и каждый из этих судов называет это сам. Общие части ядра имён моделей не пишут (P108).
   */
  ladder?: AdapterLadder;
  /**
   * Транскрипт разговора на месте (P15): `false` — нет, `undefined` — неизвестно; нет метода —
   * переходник продолжения по транскрипту не знает.
   */
  transcriptPresent?(
    pin: Record<string, string>,
    conversationId: string,
    /** Каталог кончившейся сессии ядра: дом CLI своего у каждого сеанса — транскрипт там. */
    sessionDir?: string,
  ): boolean | undefined;
  /**
   * Разговор, начатый не ядром, принадлежит ЭТОМУ корню (этап 10, F2): транскрипт id лежит в
   * собственном хранилище CLI и сам называет своей папкой `root`. `true` — доказано; `false` —
   * нет транскрипта или он другого корня; `undefined` — не прочитать. Нет метода — формат
   * хранилища для CLI не доказан, и чужой разговор ядро не продолжает (`resume_unproven`).
   */
  ownsTranscript?(
    pin: Record<string, string>,
    root: string,
    conversationId: string,
  ): boolean | undefined;
  /**
   * Переходник снимает ВСЕ встроенные инструменты CLI (`ToolSet` `none`, вопрос «ask», этап 10
   * F2) — доказанным флагом CLI, а не запретом по классам. Нет — дорога отказывает `none`
   * до запуска (`tools-none-unsupported`): вопрос без инструментов не идёт с инструментами.
   */
  toolsNone?: true;
  /**
   * Как переходник держит `SessionSpec.ephemeral` без следа: `flag` — доказанный флаг CLI не
   * пишет разговор на диск вовсе; `session-home` — флага нет, но дом CLI свой у каждого сеанса
   * (внутри `spec.dir`), хранилища человека разговор не касается. Нет — замер базы этот CLI не
   * запускает: проба оставила бы чат в его хранилище.
   */
  ephemeral?: 'flag' | 'session-home';
  /**
   * Переходник умеет `layer.sources = 'user'` (этап 10, F6) — доказанным флагом CLI: только слой
   * человека из дома конфигурации пина, без проекта и предков. Нет — дорога отказывает до запуска.
   */
  userSourcesOnly?: true;
  /**
   * Что переходник несёт из `layer.carry` (G6) доказанным флагом CLI. Поле без отметки здесь —
   * отказ дороги `session-carry-unsupported` с его именем, а не тихая потеря.
   */
  sessionCarry?: { readonly [K in keyof SessionLayerCarry]?: true };
  /**
   * Переходник издаёт `agent.*` / `bg.*` из строк задач своего потока (этап 11, P148) — доказанным
   * случаем набора соответствия (`background-facts.test.ts`, P121). Нет — субагенты и фон этого
   * CLI в дереве агентов не видны, а не «их не было».
   */
  backgroundFacts?: true;
  /** Слой чтения CLI с закреплённым окружением задачи (`SessionSpec.env.pin`); без IO. */
  readLayer(pin: Record<string, string>): ReadLayer;
  /**
   * Опись слоя человека с пином задачи (06:114, P87): хуки, навыки, агенты, инструкции и их хеш —
   * для `layer.changed`, решения `layer-run`, ключа замера базы, кандидатов безымянного отказа
   * хука и модели определения подагента. Нет метода — опись неизвестна (`null`), не «пусто».
   */
  inventory?(
    pin: Record<string, string>,
    cwd: string,
    repoLayer: boolean,
    session?: InventorySession,
  ): UserLayerInventory;
  /**
   * Серверы MCP человека в конфиге самого CLI (P73, s10 p7) — предложения строгого списка шага,
   * в порядке CLI пользователь/проект. Нет метода — CLI предложений не даёт (не «пусто»).
   */
  mcpSource?(input: McpSourceInput): McpSourceRead;
  caps: AdapterCaps;
  /**
   * Этап 12 (P170): текст ошибки хода зовёт войти в CLI заново — только подозрение, решает
   * `loginState`. Нет метода — потерю входа этот CLI не называет (`caps.loginLost`).
   */
  loginLost?(text: string): boolean;
  /** Перечитать вход CLI задокументированным чтением; нет — `unknown`. */
  loginState?(): Promise<'up' | 'absent' | 'unknown'>;
  bindEndpoint(
    channel: AdapterChannelSummary,
    endpoint: BoundEndpoint,
    limits?: LocalLimits,
  ): BindOutcome;
  /** `layer` — слой, с которым сеанс запущен на деле (F-86); журнал пишет его в запуск сеанса. */
  launch(
    spec: SessionSpec,
  ): Promise<{ ok: true; handle: SessionHandle; layer: LayerRun } | { ok: false; reason: string }>;
  events(handle: SessionHandle, options?: { pollMs?: number }): AsyncIterable<AdapterEvent>;
  /**
   * `origin` — чей это текст (G2): метку платформы ставит переходник по нему; нет — `platform`.
   * Переходники до зоны слоя его не читают.
   */
  send(
    handle: SessionHandle,
    message: string,
    cmdId: string,
    origin?: SendOrigin,
    /**
     * Картинки к отправке (вопрос «ask», этап 10 F2): только у переходника с `caps.images`;
     * дорога отказывает картинкам до запуска, если возможности нет, и переходник без неё их не
     * получает.
     */
    images?: readonly SendImage[],
  ): Promise<{ dup: boolean }>;
  stop(handle: SessionHandle, mode: StopMode): Promise<StopOutcome>;
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Форма вопроса о праве у этого CLI (сервер права или `permit.request`) и ответа на него. */
  permitCodec: PermitCodec;
  /** Ответ на `permit.request` (форма ответа — та, что вернул кодек права ядра). */
  answerPermit?(handle: SessionHandle, requestId: string, reply: unknown): Promise<void>;
  usage(handle: SessionHandle): TurnUsage[];
  /**
   * Нормализатор потока для ВИДА сеанса (этап 10, `GET …/sessions/:sid/stream`): свежий на каждый
   * повтор `stdout.log`, тот же разбор, что у живого насоса. `expect` — отправка ядра из
   * `core-io.jsonl`, чтобы ход человека встал на своё место. Нет метода — вида у CLI нет.
   * `dir` — каталог сеанса: переходнику JSON-RPC разбор нужен с входом запуска (`rpc-view.json`);
   * вида нет по названной причине — исключение `NoSessionView` (маршрут: 501 `no-view`).
   */
  streamNormaliser?(dir: string): StreamNormaliser;
}

export interface StreamNormaliser {
  expect(cmdId: string, uuid: string): void;
  push(line: string): AdapterEvent[];
  /** Текст хода человека из записанной строки stdin; нет — форма `stream-json` (`message.content`). */
  turnText?(data: string): string;
}
