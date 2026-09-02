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
  /**
   * Каталог установки исчез с диска. CLI такой плагин всё равно перечисляет как
   * установленный, поэтому о пропаже говорит панель — иначе «включённый» плагин
   * без файлов выглядит рабочим.
   */
  installPathMissing: boolean().optional(),
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
  /**
   * Почему список может быть неполным: CLI не ответил или не найден. Пустой
   * список без причины читался бы как «плагинов нет».
   */
  notes: array(string()),
});

export type PluginsState = Infer<typeof pluginsStateSchema>;

/** Результат команды CLI: код возврата и вывод — их показываем как есть. */
export const commandResultSchema = object({
  ok: boolean(),
  output: string(),
  needsRestart: boolean(),
});

export type CommandResult = Infer<typeof commandResultSchema>;

/**
 * Какие части каркаса плагина создавать. Манифест и README пишутся всегда, а
 * команды, агенты, скиллы и хуки — по выбору: пустые папки только мешают.
 */
export const pluginScaffoldComponentsSchema = object({
  commands: boolean(),
  agents: boolean(),
  skills: boolean(),
  hooks: boolean(),
});

export type PluginScaffoldComponents = Infer<typeof pluginScaffoldComponentsSchema>;

/**
 * Запрос на создание каркаса плагина. Плагин раскладывается в подпапку `<имя>`
 * внутри выбранного каталога — так выбранная папка не смешивается с чужими
 * файлами, а существующий плагин без явного `force` не перезаписывается.
 */
export const pluginScaffoldRequestSchema = object({
  /** Абсолютный путь каталога, выбранного через FolderPicker. */
  dir: string(),
  /** Имя плагина: станет именем папки и полем `name` в манифесте. */
  name: string(),
  description: string().optional(),
  author: string().optional(),
  components: pluginScaffoldComponentsSchema,
  /** Перезаписать, если папка плагина уже есть. */
  force: boolean().optional(),
});

export type PluginScaffoldRequest = Infer<typeof pluginScaffoldRequestSchema>;

/** Итог скаффолдинга: куда положили плагин и какие файлы создали. */
export const pluginScaffoldResultSchema = object({
  ok: boolean(),
  /** Абсолютный путь созданного каталога плагина. */
  path: string(),
  /** Созданные файлы — путями от корня плагина. */
  created: array(string()),
  /** Причина отказа: папка уже существует, недопустимое имя и т. п. */
  error: string().optional(),
});

export type PluginScaffoldResult = Infer<typeof pluginScaffoldResultSchema>;
