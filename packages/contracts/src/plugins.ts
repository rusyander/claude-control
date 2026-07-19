import { object, string, boolean, array, number, type infer as Infer } from 'zod';

/**
 * Плагины Claude Code. В отличие от остальных разделов, здесь приложение не
 * правит файлы напрямую, а вызывает штатный CLI (`claude plugin …`):
 * установка тянет репозиторий маркетплейса и обновляет сразу несколько файлов,
 * повторять эту логику руками — верный способ рассинхронизировать состояние.
 */
export const pluginSchema = object({
  /** Полный идентификатор вида `имя@маркетплейс`. */
  id: string(),
  name: string(),
  marketplace: string(),
  version: string(),
  scope: string(),
  isEnabled: boolean(),
  installPath: string().optional(),
  installedAt: string().optional(),
  lastUpdated: string().optional(),
  /** Плагин доступен в маркетплейсе, но не установлен. */
  isInstalled: boolean(),
  description: string().optional(),
  /** Сколько раз плагин ставили — есть только у записей каталога. */
  installCount: number().optional(),
});

export type Plugin = Infer<typeof pluginSchema>;

export const marketplaceSchema = object({
  name: string(),
  /** Источник: обычно репозиторий GitHub. */
  source: string(),
  installLocation: string().optional(),
  lastUpdated: string().optional(),
});

export type Marketplace = Infer<typeof marketplaceSchema>;

export const pluginsStateSchema = object({
  installed: array(pluginSchema),
  available: array(pluginSchema),
  marketplaces: array(marketplaceSchema),
});

export type PluginsState = Infer<typeof pluginsStateSchema>;

/** Результат команды CLI: код возврата и вывод — их показываем как есть. */
export const commandResultSchema = object({
  ok: boolean(),
  output: string(),
  needsRestart: boolean(),
});

export type CommandResult = Infer<typeof commandResultSchema>;
