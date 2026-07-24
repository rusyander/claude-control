import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * API-ключи провайдеров и резолвинг раннера ассистента (Ф6a).
 *
 * Инфраструктура мультимодельного ассистента: панель хранит API-ключи по
 * провайдеру (ЗАШИФРОВАННО, на сервере) и решает, как запускать ассистента —
 * напрямую через API (есть ключ), через CLI провайдера (ключа нет, но CLI
 * установлен) или никак (`none` — панель просит ключ). Реальных вызовов моделей
 * на этой фазе НЕТ.
 *
 * БЕЗОПАСНОСТЬ: сам ключ наружу НИКОГДА не отдаётся — только маска (`sk-…last4`)
 * и статус. Секреты не эхоятся в ответах на запись.
 */

/** Тип модельного API провайдера. `none` — своего модельного API нет (Cursor). */
export const assistantApiKinds = [
  'anthropic',
  'openai',
  'google',
  'openai-compat',
  'none',
] as const;
export type AssistantApiKind = (typeof assistantApiKinds)[number];

/** Откуда взят ключ: сохранён в панели, из окружения, или ключа нет. */
export const keySources = ['stored', 'env'] as const;
export type KeySource = (typeof keySources)[number] | null;

/** Статус ключа провайдера — без раскрытия самого ключа. */
export const keyStatusSchema = object({
  present: boolean(),
  /** 'stored' | 'env' | null. */
  source: zodEnum(keySources).nullable(),
  /** Маска (`sk-…1a2b`); пусто, если ключа нет. Полный ключ наружу не отдаётся. */
  masked: string(),
  /** Имя env-переменной, из которой подхвачен ключ (когда source = 'env'). */
  envVar: string().optional(),
});
export type KeyStatus = Infer<typeof keyStatusSchema>;

/** Одна строка списка `GET /api/provider-keys`. */
export const providerKeyItemSchema = object({
  providerId: string(),
  providerName: string(),
  apiKind: zodEnum(assistantApiKinds),
  /** Может ли провайдер держать ключ (apiKind ≠ none). */
  supported: boolean(),
  keyStatus: keyStatusSchema,
  /** Стандартные env-переменные, из которых ключ подхватывается автоматически. */
  envVars: array(string()),
});
export type ProviderKeyItem = Infer<typeof providerKeyItemSchema>;

/** Ответ `GET /api/provider-keys`: активный провайдер + список статусов ключей. */
export const providerKeysResponseSchema = object({
  active: string(),
  items: array(providerKeyItemSchema),
});
export type ProviderKeysResponse = Infer<typeof providerKeysResponseSchema>;

/** Тело `PUT /api/provider-keys/:id`: сам ключ. Наружу он не эхоится. */
export const providerKeyDraftSchema = object({
  key: string(),
});
export type ProviderKeyDraft = Infer<typeof providerKeyDraftSchema>;

/** Режим запуска ассистента активного провайдера. */
export const runnerModes = ['api', 'cli', 'none'] as const;
export type RunnerMode = (typeof runnerModes)[number];

/** Причина итогового режима (для i18n на клиенте). */
export const runnerReasons = ['api_key', 'cli_found', 'no_key_no_cli', 'unsupported'] as const;
export type RunnerReason = (typeof runnerReasons)[number];

/** Ответ `GET /api/provider-runner`: резолв раннера активного провайдера. */
export const providerRunnerInfoSchema = object({
  providerId: string(),
  providerName: string(),
  apiKind: zodEnum(assistantApiKinds),
  mode: zodEnum(runnerModes),
  reason: zodEnum(runnerReasons),
  keyStatus: keyStatusSchema,
  /** Найден ли бинарь CLI провайдера в PATH. */
  cliFound: boolean(),
  /** Поддерживается ли запуск через CLI (у Cursor — нет). */
  cliRunnable: boolean(),
  /** Имя команды CLI провайдера под текущую ОС. */
  cliCommand: string(),
});
export type ProviderRunnerInfo = Infer<typeof providerRunnerInfoSchema>;

/** Ответ на запись/очистку ключа: обновлённый маскированный статус. */
export const providerKeyResultSchema = object({
  ok: boolean(),
  providerId: string(),
  keyStatus: keyStatusSchema,
});
export type ProviderKeyResult = Infer<typeof providerKeyResultSchema>;
