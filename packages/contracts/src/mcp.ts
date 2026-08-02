import {
  object,
  string,
  array,
  boolean,
  number,
  record,
  enum as zodEnum,
  unknown as zodUnknown,
  type infer as Infer,
} from 'zod';

export const mcpTransportSchema = zodEnum(['stdio', 'sse', 'http']);
export type McpTransport = Infer<typeof mcpTransportSchema>;

/** Живой статус сервера — результат проверки здоровья. */
export const mcpHealthSchema = zodEnum([
  'connected', // отвечает
  'failed', // не отвечает или падает
  'disabled', // выключен в приложении, в конфиг не пишется
  'unknown', // проверка ещё не запускалась
]);

export type McpHealth = Infer<typeof mcpHealthSchema>;

export const mcpServerSchema = object({
  /** Имя сервера в конфиге — оно же идентификатор. */
  id: string(),
  name: string(),
  transport: mcpTransportSchema,
  /** Для stdio: команда запуска и аргументы. */
  command: string().optional(),
  args: array(string()).default([]),
  /** Для sse/http: адрес. */
  url: string().optional(),
  /**
   * Переменные окружения сервера из конфига. Секретов тут быть не должно —
   * значения вида ${VAR} или имена ключей для внешнего файла секретов.
   */
  env: record(string(), string()).default({}),
  headers: record(string(), string()).default({}),
  health: mcpHealthSchema,
  /** Текст ошибки последней проверки, если health = failed. */
  healthDetail: string().optional(),
  /** Когда health проверялся последний раз (ISO). */
  checkedAt: string().optional(),
  isEnabled: boolean(),
  groupIds: array(string()),
  /** Сколько инструментов отдаёт сервер — заполняется после проверки. */
  toolCount: number().optional(),
  /**
   * Есть ли сохранённый OAuth-токен. Только у сетевых серверов; по нему
   * интерфейс решает, показать «Авторизоваться» или «Авторизован · Выйти».
   */
  hasOAuth: boolean().default(false),
});

export type McpServer = Infer<typeof mcpServerSchema>;

export const mcpServerDraftSchema = object({
  name: string().min(1),
  transport: mcpTransportSchema,
  command: string().optional(),
  args: array(string()).default([]),
  url: string().optional(),
  env: record(string(), string()).default({}),
  headers: record(string(), string()).default({}),
  groupIds: array(string()).default([]),
});

export type McpServerDraft = Infer<typeof mcpServerDraftSchema>;

/** Инструмент MCP-сервера — имя и описание для помощника отбора прав. */
export const mcpToolSchema = object({
  name: string(),
  description: string().optional(),
});

export type McpTool = Infer<typeof mcpToolSchema>;

/**
 * Тот же инструмент, но со СХЕМОЙ ПАРАМЕТРОВ — форма ответа песочницы
 * (`/api/sandbox/mcp-tools`). Схема нужна ровно там: по ней рисуется форма
 * вызова инструмента. Помощник отбора прав (`/api/mcp/:id/tools`) её не
 * получает — ему хватает имени и описания, и лишнее в ответе там ни к чему.
 *
 * Форм две, а не одна с необязательным полем, потому что разные и ответы: одна
 * ручка схему НЕ отдаёт никогда, вторая отдаёт, когда сервер её сообщил.
 */
export const mcpToolDetailSchema = object({
  name: string(),
  description: string().optional(),
  /** Схема параметров как есть, в терминах самого MCP-сервера. */
  inputSchema: zodUnknown().optional(),
});

export type McpToolDetail = Infer<typeof mcpToolDetailSchema>;

/**
 * Ответ маршрута списка инструментов сервера. Неудачу отдаём значением, а не
 * исключением: помощник отбора прав показывает текст ошибки тем же блоком, что и
 * список, — недоступный сервер не должен ронять запрос.
 */
export const mcpToolsResultSchema = object({
  tools: array(mcpToolSchema),
  error: string().optional(),
});

export type McpToolsResult = Infer<typeof mcpToolsResultSchema>;
