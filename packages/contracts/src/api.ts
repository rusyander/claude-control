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
  /**
   * Чей конфиг посчитан: активный провайдер панели. Счётчики разделов ниже —
   * из его файлов (Claude — свои читатели, прочие — адаптеры `readProvider<X>Info`).
   */
  provider: object({ id: string(), name: string() }),
  /** `null` — у активного провайдера такого раздела нет (или панель его не считает). */
  rules: object({ total: number(), enabled: number() }).nullable(),
  hooks: object({ total: number(), enabled: number(), broken: number() }).nullable(),
  skills: object({ total: number(), enabled: number() }).nullable(),
  /** Файлы в hooks/: всего и сколько из них не привязано ни к одному событию. */
  scripts: object({ total: number(), unused: number() }),
  mcp: object({
    total: number(),
    enabled: number(),
    connected: number(),
    failed: number(),
  }).nullable(),
  permissions: object({ allow: number(), ask: number(), deny: number() }).nullable(),
  groups: object({ total: number() }),
});

export type Overview = Infer<typeof overviewSchema>;
