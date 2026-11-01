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
  /**
   * Части слоя человека, которые до сеанса не дошли (G-b): по одной на строку, без префикса. Дорога
   * пишет каждую сигналом `layer-loss`; нет поля — потерь нет. Отдельным полем, а не текстом в
   * `detail`: разбор строки по префиксу молча терял бы потерю, чей текст сменил форму.
   */
  losses?: string[];
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
  /**
   * `skills` — навыки человека (06:115): шаг сценария называет режим всегда (дорога берёт его из
   * `userLayer` шага), умолчания в переходнике нет — иначе «не спросили» и «включены» совпали бы.
   */
  layer: { hooks: LayerMode; skills: SkillMode };
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
  | { type: 'error'; code: AdapterErrorCode; detail: string };

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
}

export interface CliAdapter {
  id: string;
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
  transcriptPresent?(pin: Record<string, string>, conversationId: string): boolean | undefined;
  /** Слой чтения CLI с закреплённым окружением задачи (`SessionSpec.env.pin`); без IO. */
  readLayer(pin: Record<string, string>): ReadLayer;
  /**
   * Опись слоя человека с пином задачи (06:114, P87): хуки, навыки, агенты, инструкции и их хеш —
   * для `layer.changed`, решения `layer-run`, ключа замера базы, кандидатов безымянного отказа
   * хука и модели определения подагента. Нет метода — опись неизвестна (`null`), не «пусто».
   */
  inventory?(pin: Record<string, string>, cwd: string, repoLayer: boolean): UserLayerInventory;
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
  /**
   * `origin` — чей это текст (G2): метку платформы ставит переходник по нему; нет — `platform`.
   * Переходники до зоны слоя его не читают.
   */
  send(
    handle: SessionHandle,
    message: string,
    cmdId: string,
    origin?: SendOrigin,
  ): Promise<{ dup: boolean }>;
  stop(handle: SessionHandle, mode: StopMode): Promise<StopOutcome>;
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Форма вопроса о праве у этого CLI (сервер права или `permit.request`) и ответа на него. */
  permitCodec: PermitCodec;
  /** Ответ на `permit.request` (форма ответа — та, что вернул кодек права ядра). */
  answerPermit?(handle: SessionHandle, requestId: string, reply: unknown): Promise<void>;
  usage(handle: SessionHandle): TurnUsage[];
}
