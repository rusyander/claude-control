import { object, string, boolean, number, type infer as Infer } from 'zod';

/** Результат записи в конфиг — с путём к резервной копии, если она делалась. */
export const writeResultSchema = object({
  ok: boolean(),
  backupPath: string().optional(),
  /** Требуется ли перезапуск Claude Code, чтобы изменения применились. */
  needsRestart: boolean(),
});

export type WriteResult = Infer<typeof writeResultSchema>;

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
