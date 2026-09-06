import { object, string, boolean, array, unknown, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Тела мутирующих запросов чата, прав и git: схемы, по которым сервер проверяет
 * вход, и типы, выведенные из них же (`Infer`) — не написанные руками рядом с
 * маршрутом. Битое тело (телефон старой версии, `curl` руками) раньше доходило
 * до домена и падало внутри с 500; теперь маршрут отвечает 400 с именем поля.
 *
 * Сервер берёт этот файл по подпути `@claude-control/contracts/request-bodies`:
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
   * Автоподтверждение безопасных запросов прав — тумблером из шапки чата.
   * Опасное (git-записи, удаление, миграции) и всё под правилами `ask`/`deny`
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
export type GitPathBody = Infer<typeof gitPathBodySchema>;
export type GitCheckoutBody = Infer<typeof gitCheckoutBodySchema>;
export type GitBranchBody = Infer<typeof gitBranchBodySchema>;
export type GitCommitBody = Infer<typeof gitCommitBodySchema>;
export type GitPullBody = Infer<typeof gitPullBodySchema>;
export type GitWorktreeAddBody = Infer<typeof gitWorktreeAddBodySchema>;
export type GitWorktreeRemoveBody = Infer<typeof gitWorktreeRemoveBodySchema>;
