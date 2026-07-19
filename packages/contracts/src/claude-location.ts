import { object, string, boolean, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Как был найден каталог `.claude`. Показывается в настройках, чтобы пользователь
 * понимал, откуда взялся путь, и мог его переопределить.
 */
export const detectionSourceSchema = zodEnum([
  'env', // переменная окружения CLAUDE_CONFIG_DIR
  'home', // стандартный ~/.claude
  'manual', // задан пользователем в настройках приложения
  'not-found', // не найден — нужен ручной ввод
]);

export type DetectionSource = Infer<typeof detectionSourceSchema>;

/** Файлы и папки внутри `.claude`, с которыми работает приложение. */
export const claudePathsSchema = object({
  root: string(), // сам каталог .claude
  settings: string(), // settings.json — хуки, permissions, env
  settingsLocal: string(), // settings.local.json
  claudeMd: string(), // CLAUDE.md — личные правила
  secretsEnv: string(), // .mcp-secrets.env — токены
  skills: string(), // каталог skills/
  hooks: string(), // каталог hooks/
  mcpConfig: string(), // ~/.claude.json — ВНЕ каталога .claude
  appData: string(), // claude-control/ — данные самого приложения (группы, связи)
});

export type ClaudePaths = Infer<typeof claudePathsSchema>;

/** Результат обнаружения каталога конфигурации. */
export const claudeLocationSchema = object({
  paths: claudePathsSchema,
  source: detectionSourceSchema,
  /** Каталог существует и доступен на чтение. */
  isValid: boolean(),
  /** Каких ожидаемых файлов не хватает — не ошибка, но полезно показать. */
  missing: array(string()),
  /** Человекочитаемая причина, если isValid = false. */
  problem: string().optional(),
});

export type ClaudeLocation = Infer<typeof claudeLocationSchema>;
