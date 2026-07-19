import {
  object,
  string,
  array,
  boolean,
  number,
  record,
  enum as zodEnum,
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
