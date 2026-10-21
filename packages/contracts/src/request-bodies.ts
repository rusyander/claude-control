import {
  object,
  string,
  boolean,
  number,
  array,
  record,
  unknown,
  union,
  tuple,
  literal,
  enum as zodEnum,
  type infer as Infer,
} from 'zod';

/**
 * Тела мутирующих запросов чата, прав и git: схемы, по которым сервер проверяет
 * вход, и типы, выведенные из них же (`Infer`) — не написанные руками рядом с
 * маршрутом. Битое тело (телефон старой версии, `curl` руками) раньше доходило
 * до домена и падало внутри с 500; теперь маршрут отвечает 400 с именем поля.
 *
 * Сервер берёт этот файл по подпути `@agentdeck/contracts/request-bodies`:
 * zod-ЗНАЧЕНИЯ из барреля в Node не резолвятся (см. `providers/settings-validation/settings-validation.ts`).
 * Неизвестные поля zod отбрасывает — клиент новее сервера от этого не ломается.
 */

/** Вложение к сообщению: имя решает, поддерживается ли формат, содержимое — base64. */
const uploadSchema = object({ name: string().min(1), base64: string() });

export const chatSendBodySchema = object({
  chatId: string().min(1),
  prompt: string(),
  sessionId: string().optional(),
  name: string().optional(),
  /** Ветвление: правка своего сообщения не дописывает разговор, а создаёт ветку. */
  fork: boolean().optional(),
  files: array(uploadSchema).optional(),
  /** Разрешить правку файлов в настоящем проекте — тумблером из шапки. */
  allowEdits: boolean().optional(),
  /** Полный доступ (bypassPermissions) — «Разрешить и продолжить» у упавшего агента. */
  fullAccess: boolean().optional(),
  /**
   * Авторежим прав этого чата — выбор человека тумблером в меню чата. Задан —
   * сильнее глобальной `chatAutoMode` в обе стороны и запоминается за чатом; не
   * задан — действует запомненный выбор чата, а без него глобальная настройка.
   * Опасное (удаление, затирание истории) и всё под правилами `ask`/`deny`
   * по-прежнему спрашивают человека.
   */
  autoApprove: boolean().optional(),
  /** Каталог проекта для нового разговора — когда чат открыт из списка проектов. */
  projectPath: string().optional(),
  /**
   * Разговор, из которого этот запущен. Не «откуда нажали», а РОДИТЕЛЬ: по
   * нему чат встаёт ветвью в дереве списка, а его вопросы и запросы прав
   * показываются в родителе. Так работает разделение задач; параллельный
   * запуск ходит тем же путём, иначе каждый его агент заводил бы отдельную
   * вкладку проекта и терялся вместе со своим вопросом.
   */
  parentChatId: string().optional(),
  /** Подпись ветви в дереве: имя проекта или группы. */
  parentTitle: string().optional(),
  /** Модель для этого разговора (алиас или полное имя); пусто = по умолчанию. */
  model: string().optional(),
  /** Глубина продумывания (--effort); пусто = по умолчанию. */
  effort: string().optional(),
  /**
   * Прогон ведёт ступень НИЖЕ потолка разговора — так панель раздаёт модели
   * вееру ручного параллельного запуска. Значит ровно две вещи, и обе делает
   * сервер: `model` пришла АЛИАСОМ лестницы (`sonnet`), и разворачивать его в
   * свежую модель семейства обязана панель — алиас CLI означает
   * «рекомендованная модель уровня», а не последнюю; и заданию полагается
   * планка сдачи, та же, что у понижённой группы разделения.
   */
  lowered: boolean().optional(),
  /**
   * Разговор занят — не отказывать, а поставить сообщение в очередь сервера:
   * оно уйдёт продолжением той же сессии, как только ход кончится. Так отвечает
   * хаб родителя ребёнку, чей прогон вкладка не знает (отцепленная группа):
   * 409 здесь терял бы ответ человека. Ответ — 202 `{ queued: true, runId }`.
   */
  queueIfBusy: boolean().optional(),
  /**
   * Сообщение посреди хода — сразу агенту (живая сессия Claude): CLI отдаёт его
   * модели на ближайшем шаге, вместе с результатом текущего вызова, и ход
   * продолжается с ним. Не вышло (прогон не живой, вложения) — как без поля.
   */
  steer: boolean().optional(),
  /**
   * Метка сообщения от клиента. Сервер помнит метки отданных агенту сообщений:
   * слово на ходу дошло, а ответ на запрос клиент потерял (обрыв, сон телефона)
   * и дослал его из своей очереди — повтор получает 202 `{ steered, duplicate }`
   * и второй раз агенту не уходит.
   */
  clientId: string().min(1).optional(),
  /**
   * Отправил не человек сейчас, а сама панель: очередь вкладки по концу хода,
   * автоповтор после сбоя. Группу на паузе такое не будит — 409 `group_paused`;
   * паузу снимает только «Продолжить» или сообщение человека.
   */
  automatic: boolean().optional(),
});
export type ChatSendBody = Infer<typeof chatSendBodySchema>;

/** Тумблер автоподтверждения во время прогона. Тела может не быть вовсе — это «выключено». */
export const autoApproveBodySchema = object({ enabled: boolean().optional() }).optional();
export type AutoApproveBody = Infer<typeof autoApproveBodySchema>;

/** Запрос прав от мини-MCP-сервера: какой инструмент и с чем пришёл. */
export const permissionRequestBodySchema = object({
  runId: string().min(1),
  toolName: string().min(1),
  input: unknown(),
  toolUseId: string(),
});
export type PermissionRequestBody = Infer<typeof permissionRequestBodySchema>;

/** Решение человека по запросу прав (клик «Разрешить»/«Запретить»). */
export const permissionDecisionBodySchema = object({
  toolUseId: string().min(1),
  behavior: zodEnum(['allow', 'deny']),
  message: string().optional(),
});
export type PermissionDecisionBody = Infer<typeof permissionDecisionBodySchema>;

/**
 * Ответ человека воротам ветки. `copy` — завести копию с веткой и продолжить
 * разговор в ней, `here` — писать в основной копии (до конца прогона больше не
 * спрашивать), `stop` — отклонить саму правку.
 *
 * Имя ветки приходит от человека: панель его лишь предложила. Проверяет имя git
 * (`check-ref-format`) — здесь только форма поля, иначе отказ звучал бы дважды и
 * по-разному.
 */
export const branchDecisionBodySchema = object({
  toolUseId: string().min(1),
  choice: zodEnum(['copy', 'here', 'stop']),
  branch: string().optional(),
});
export type BranchDecisionBody = Infer<typeof branchDecisionBodySchema>;

/**
 * Git: каталог приходит путём. Сам путь (абсолютный, существует, каталог) проверяет
 * маршрут той же проверкой, что и реестр проектов, — здесь только форма поля.
 * Пустые строки не отсекаются намеренно: на них отвечает git своим текстом.
 */
const gitPathSchema = string().optional();
export const gitPathBodySchema = object({ path: gitPathSchema });
export const gitCheckoutBodySchema = object({ path: gitPathSchema, branch: string() });
export const gitBranchBodySchema = object({ path: gitPathSchema, name: string() });
export const gitCommitBodySchema = object({ path: gitPathSchema, message: string() });
/** Пустая строка ветки приходит от селекта «текущая ветка» и равна отсутствию поля. */
export const gitPullBodySchema = object({ path: gitPathSchema, branch: string().optional() });
export const gitWorktreeAddBodySchema = object({ path: gitPathSchema, name: string() });
export const gitWorktreeRemoveBodySchema = object({
  path: gitPathSchema,
  worktreePath: string().trim().min(1),
  force: boolean().optional(),
});
/** Повторное зеркало локального слоя в уже существующую копию. */
export const gitWorktreeMirrorBodySchema = object({
  path: gitPathSchema,
  worktreePath: string().trim().min(1),
});
/** Шаблоны зеркала на проекте: по строке на шаблон, пустые строки отбрасываются. */
export const gitMirrorSettingsBodySchema = object({
  path: gitPathSchema,
  include: array(string().max(400)).max(200),
  exclude: array(string().max(400)).max(200),
  /** Команда после создания копии; пусто — по lock-файлу. */
  bootstrap: string().max(2000).optional(),
});
/** Разделение на проекте: доставка до MR и сколько групп разом (`SplitSettings`). */
export const splitSettingsBodySchema = object({
  path: gitPathSchema,
  deliver: boolean(),
  /** `null` — вернуть общий потолок вкладки «Группы» (лёгкий или тяжёлый проект). */
  parallel: number().int().min(1).max(30).nullable(),
  /**
   * Строки разрешений групп, переопределённые проектом. Нет поля — строки не
   * трогаем (так шлёт кнопка «До MR»); `null` — сбросить к общим.
   */
  permissions: record(string(), union([boolean(), zodEnum(['auto', 'notify', 'human'])]))
    .nullable()
    .optional(),
});
/** Повторный бутстрап уже существующей копии — кнопкой на карточке. */
export const gitWorktreeBootstrapBodySchema = object({
  path: gitPathSchema,
  worktreePath: string().trim().min(1),
});
export type GitPathBody = Infer<typeof gitPathBodySchema>;
export type GitCheckoutBody = Infer<typeof gitCheckoutBodySchema>;
export type GitBranchBody = Infer<typeof gitBranchBodySchema>;
export type GitCommitBody = Infer<typeof gitCommitBodySchema>;
export type GitPullBody = Infer<typeof gitPullBodySchema>;
export type GitWorktreeAddBody = Infer<typeof gitWorktreeAddBodySchema>;
export type GitWorktreeRemoveBody = Infer<typeof gitWorktreeRemoveBodySchema>;
export type GitWorktreeMirrorBody = Infer<typeof gitWorktreeMirrorBodySchema>;
export type GitMirrorSettingsBody = Infer<typeof gitMirrorSettingsBodySchema>;
export type GitWorktreeBootstrapBody = Infer<typeof gitWorktreeBootstrapBodySchema>;

/**
 * «Остановить» сессию вне панели (вкладка «Сессии» аналитики). `pid` и
 * `startedAt` — ровно то, что человек видел в окне подтверждения: сервер
 * снимает процесс, только если под этим номером всё ещё он. `allowPanel` —
 * явная отмашка, когда из этой сессии запущена сама панель.
 */
export const sessionStopBodySchema = object({
  pid: number().int().positive(),
  // Не дата — кривой запрос (400), а не «номер занят другим процессом» (F-361).
  startedAt: string()
    .min(1)
    .refine((value) => Number.isFinite(Date.parse(value)), 'время запуска — дата ISO'),
  allowPanel: boolean().optional(),
});

export type SessionStopBody = Infer<typeof sessionStopBodySchema>;

/** Цель в «Запустить всё» проекта: корень вкладки, подпапка цели и отметка. */
export const runnerGroupBodySchema = object({
  path: string().min(1),
  dir: string().optional(),
  inGroup: boolean(),
});
/** «Запустить всё» / «Остановить всё»: корень вкладки проекта. */
export const runnerProjectBodySchema = object({ path: string().min(1) });

export type RunnerGroupBody = Infer<typeof runnerGroupBodySchema>;
export type RunnerProjectBody = Infer<typeof runnerProjectBodySchema>;

/**
 * Действие над Compose проекта. `service` пустое — над всем стеком.
 * `confirm` обязателен для `down-volumes`: тома — это данные, и удалить их
 * случайным запросом (старый клиент, `curl` руками) нельзя.
 */
export const composeActionBodySchema = object({
  path: string().min(1),
  action: zodEnum(['up', 'stop', 'restart', 'down', 'down-volumes']),
  service: string().min(1).optional(),
  confirm: boolean().optional(),
});

export type ComposeActionBody = Infer<typeof composeActionBodySchema>;

/**
 * Запрос к базе проекта. Только чтение: сервер сам открывает транзакцию READ
 * ONLY и пропускает один оператор. 100 000 символов — с запасом на длинный
 * отчётный запрос, но не мегабайт текста в одном теле.
 */
export const dbQueryBodySchema = object({
  path: string().min(1),
  connectionId: string().min(1),
  sql: string().min(1).max(100_000),
  mode: zodEnum(['run', 'explain', 'explain-analyze']).optional(),
});

/** Своё подключение к базе. `id` — правка существующего; пароль пустой — оставить прежний. */
export const dbConnectionBodySchema = object({
  path: string().min(1),
  id: string().min(1).optional(),
  label: string().trim().min(1).max(80),
  host: string().trim().min(1).max(255),
  port: number().int().min(1).max(65_535),
  database: string().trim().min(1).max(128),
  user: string().trim().min(1).max(128),
  password: string().max(1024).optional(),
});

/** Убрать своё подключение (найденные в файлах проекта не убираются — их правят в файле). */
export const dbConnectionRemoveBodySchema = object({
  path: string().min(1),
  id: string().min(1),
});

/** Переходник MCP базы для агента: записать в конфигурацию CLI или убрать. */
export const dbMcpBodySchema = object({ enabled: boolean() });

const backendGuardRuleSchema = zodEnum([
  'prod-target',
  'sql-drop',
  'sql-truncate',
  'sql-unbounded',
  'migration-down',
  'infra-change',
  'volume-delete',
]);

/** Настройки защиты бэкенда: метки прода и выключенные правила. */
export const backendGuardSettingsSchema = object({
  prodMarkers: array(string().trim().min(3).max(255)).max(100),
  disabled: array(backendGuardRuleSchema).max(7),
});

/** Поставить (или восстановить) защиту бэкенда в проекте. */
export const backendGuardInstallBodySchema = object({
  path: string().min(1),
  settings: backendGuardSettingsSchema,
  lang: zodEnum(['ru', 'en']).optional(),
});

/** Только настройки — файлы хука и правила не трогаются. */
export const backendGuardSettingsBodySchema = object({
  path: string().min(1),
  settings: backendGuardSettingsSchema,
});

export const backendGuardRemoveBodySchema = object({ path: string().min(1) });

/** «Проверить команду»: спросит ли защита. Настройки — из формы, ещё не сохранённые. */
export const backendGuardCheckBodySchema = object({
  command: string().min(1).max(20_000),
  settings: backendGuardSettingsSchema,
});

export type BackendGuardInstallBody = Infer<typeof backendGuardInstallBodySchema>;
export type BackendGuardSettingsBody = Infer<typeof backendGuardSettingsBodySchema>;
export type BackendGuardCheckBody = Infer<typeof backendGuardCheckBodySchema>;

const HTTP_URL = /^https?:\/\/\S+$/i;

const apiHeaderSchema = tuple([string().max(256), string().max(16_384)]);

/** Добавить источник контракта по адресу (`…/openapi.json` работающего сервиса или стенда). */
export const apiSourceBodySchema = object({
  path: string().min(1),
  url: string().trim().max(2048).regex(HTTP_URL),
});

export const apiSourceRemoveBodySchema = object({
  path: string().min(1),
  sourceId: string().min(1).max(2100),
});

/** Коллекция Postman: текст файла, прочитанный в браузере. */
export const apiPostmanBodySchema = object({
  path: string().min(1),
  name: string().trim().max(200).optional(),
  content: string().min(2).max(5_000_000),
});

/** Отправить запрос. `useAuth` — подставить сохранённый заголовок авторизации на сервере. */
export const apiSendBodySchema = object({
  path: string().min(1),
  method: zodEnum(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']),
  url: string().trim().min(1).max(8192),
  headers: array(apiHeaderSchema).max(100),
  body: string().max(5_000_000).optional(),
  sourceId: string().max(2100).optional(),
  endpointId: string().max(2100).optional(),
  useAuth: boolean().optional(),
});

/** Базовый адрес и заголовок авторизации проекта; `null` — убрать. */
export const apiSettingsBodySchema = object({
  path: string().min(1),
  baseUrl: union([string().trim().max(2048).regex(HTTP_URL), literal(null)]).optional(),
  auth: union([
    object({
      header: string()
        .trim()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/),
      value: string().trim().min(1).max(8192),
    }),
    literal(null),
  ]).optional(),
});

export const apiPathBodySchema = object({ path: string().min(1) });

export type ApiSendBody = Infer<typeof apiSendBodySchema>;
export type ApiSettingsBody = Infer<typeof apiSettingsBodySchema>;

export type DbQueryBody = Infer<typeof dbQueryBodySchema>;
export type DbConnectionBody = Infer<typeof dbConnectionBodySchema>;
export type DbConnectionRemoveBody = Infer<typeof dbConnectionRemoveBodySchema>;
export type DbMcpBody = Infer<typeof dbMcpBodySchema>;
