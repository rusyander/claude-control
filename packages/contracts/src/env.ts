import { object, string, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/** Откуда взялась переменная — от этого зависит, куда её сохранять. */
export const envSourceSchema = zodEnum([
  'settings', // settings.json → env, видна всем сессиям Claude Code
  'settings-local', // settings.local.json → env: личный файл, панель его только читает
  'secrets', // .mcp-secrets.env, читается лаунчером MCP-серверов
  'group', // env группы приложения
]);

export type EnvSource = Infer<typeof envSourceSchema>;

export const envVarSchema = object({
  id: string(),
  key: string(),
  /**
   * Значение приходит замаскированным, если isSecret = true:
   * в списке видно только начало и хвост. Полное значение отдаётся
   * отдельным запросом — по явному действию пользователя.
   */
  value: string(),
  isSecret: boolean(),
  source: envSourceSchema,
  /** Комментарий над переменной в env-файле — сохраняется при перезаписи. */
  comment: string().optional(),
  /** Для source = group: к какой группе относится. */
  groupId: string().optional(),
});

export type EnvVar = Infer<typeof envVarSchema>;

export const envVarDraftSchema = object({
  key: string().min(1),
  value: string(),
  source: envSourceSchema,
  isSecret: boolean().default(false),
  comment: string().optional(),
  groupId: string().optional(),
});

export type EnvVarDraft = Infer<typeof envVarDraftSchema>;
