import type {
  AdapterCaps,
  AdapterChannelSummary,
  Dialect,
  RefusalCode,
} from '@agentdeck/contracts/core/routes';
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
  /** Инструменты записи форджа по полному имени MCP (маски `mcp__<server>__*` допустимы). */
  forgeMcpTools?: readonly string[];
}

/** Сервер MCP на stdio, как его запускает CLI. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

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
}

/** Какие встроенные инструменты получает шаг (P73): ревью — только чтение. */
export type ToolSet = 'all' | 'read-only';

export interface SessionSpec {
  sessionId: string;
  /** Каталог сеанса в доме ядра. */
  dir: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Первый бриф — системным промптом (P88). */
  brief: string;
  /** Разговор CLI, который продолжаем; дельта возобновления — отдельным сообщением ядра. */
  resume?: { conversationId: string };
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
  layer: { hooks: LayerMode };
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
 * инструментов, список дел); всё, что действует (субагент, навык), остаётся `other`.
 */
export interface PermissionAsk {
  action: 'read' | 'edit' | 'exec' | 'net' | 'mcp' | 'conversation' | 'other';
  /** Путь, argv[0..], имя инструмента MCP или адрес. */
  target: string;
  argv?: string[];
  /**
   * `exec`: argv дословно тот, что исполнит оболочка (нет экранирования, раскрытий `$…`/`` `…` ``,
   * шаблонов, скобок, перенаправлений). `false` — разбор мог разойтись с оболочкой (`gi\t push`):
   * судья argv не верит и решает fail-closed (F-02). Нет поля — переходник этого не знает.
   */
  argvExact?: boolean;
  tool: string;
  display: string;
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
    }
  | { type: 'tool.result'; toolUseId: string; isError: boolean; cliInitiated: boolean }
  | { type: 'text.delta'; text: string }
  | {
      type: 'usage';
      messageId: string;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
    }
  | { type: 'ask'; ask: PermissionAsk; denied: boolean }
  /**
   * Вопрос о праве в самом потоке (у CLI нет инструмента-вопроса, он спрашивает строкой
   * протокола и ждёт ответа в stdin): ядро решает по `raw` и отвечает `answerPermit`.
   */
  | { type: 'permit.request'; requestId: string; raw: unknown }
  | { type: 'error'; code: AdapterErrorCode; detail: string };

export type AdapterErrorCode = 'fresh-required' | 'model-error' | 'exited' | 'protocol';

/** Использование одного API-хода (03 `usage(h)`). */
export interface TurnUsage {
  messageId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
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

export interface CliAdapter {
  id: string;
  /**
   * Имена образа процесса CLI (`claude` → `claude.exe` на Windows): по ним псевдозадача узнаёт
   * предка-CLI проверки из сессии человека (04:41-42, A2-F02). CLI, поставленный через npm, живёт
   * под образом `node` — такой предок не узнаётся, проверка идёт вне очереди и названа.
   */
  images: readonly string[];
  /** Слой чтения CLI с закреплённым окружением задачи (`SessionSpec.env.pin`); без IO. */
  readLayer(pin: Record<string, string>): ReadLayer;
  caps: AdapterCaps;
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
  send(handle: SessionHandle, message: string, cmdId: string): Promise<{ dup: boolean }>;
  stop(handle: SessionHandle, mode: StopMode): Promise<StopOutcome>;
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Форма вопроса о праве у этого CLI (сервер права или `permit.request`) и ответа на него. */
  permitCodec: PermitCodec;
  /** Ответ на `permit.request` (форма ответа — та, что вернул кодек права ядра). */
  answerPermit?(handle: SessionHandle, requestId: string, reply: unknown): Promise<void>;
  usage(handle: SessionHandle): TurnUsage[];
}
