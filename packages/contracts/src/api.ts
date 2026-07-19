import { object, string, array, boolean, number, type infer as Infer } from 'zod';

/** Единый конверт ошибки API — фронт показывает message пользователю как есть. */
export const apiErrorSchema = object({
  error: string(),
  message: string(),
  /** Путь к файлу, на котором споткнулись, если ошибка файловая. */
  path: string().optional(),
});

export type ApiError = Infer<typeof apiErrorSchema>;

/** Результат записи в конфиг — с путём к резервной копии, если она делалась. */
export const writeResultSchema = object({
  ok: boolean(),
  backupPath: string().optional(),
  /** Требуется ли перезапуск Claude Code, чтобы изменения применились. */
  needsRestart: boolean(),
});

export type WriteResult = Infer<typeof writeResultSchema>;

/**
 * События, которые сервер шлёт по SSE. На них фронт инвалидирует кеш
 * и подтягивает свежие данные — так интерфейс отражает правки файлов,
 * сделанные мимо приложения (руками или самим Claude Code).
 */
export const serverEventSchema = object({
  type: string(),
  /** Какие домены затронуты: rules, hooks, skills, mcp, permissions, env. */
  domains: array(string()),
  path: string().optional(),
  at: string(),
});

export type ServerEvent = Infer<typeof serverEventSchema>;

/** Сводка для главного экрана. */
export const overviewSchema = object({
  rules: object({ total: number(), enabled: number() }),
  hooks: object({ total: number(), enabled: number(), broken: number() }),
  skills: object({ total: number(), enabled: number() }),
  /** Файлы в hooks/: всего и сколько из них не привязано ни к одному событию. */
  scripts: object({ total: number(), unused: number() }),
  mcp: object({ total: number(), enabled: number(), connected: number(), failed: number() }),
  permissions: object({ allow: number(), ask: number(), deny: number() }),
  groups: object({ total: number() }),
});

export type Overview = Infer<typeof overviewSchema>;
