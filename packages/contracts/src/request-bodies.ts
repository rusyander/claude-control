import {
  object,
  string,
  boolean,
  number,
  array,
  record,
  unknown,
  union,
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
 * zod-ЗНАЧЕНИЯ из барреля в Node не резолвятся (см. `providers/settings-validation.ts`).
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
