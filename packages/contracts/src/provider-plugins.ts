import { object, string, array, boolean, number, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Плагины провайдера (OPENCODE-4) — МОДЕЛЬ, ОТЛИЧНАЯ ОТ ПЛАГИНОВ ПАНЕЛИ.
 *
 * Раздел «Плагины» у Claude — это каталог расширений САМОЙ панели, он не
 * меняется. Здесь другое: плагины CLI OpenCode, и подключаются они ДВУМЯ
 * задокументированными способами.
 *
 *  1. **ФАЙЛЫ ПЛАГИНОВ** — модули JS/TS, которые OpenCode подхватывает при старте
 *     из каталога: глобального `~/.config/opencode/plugins/` и проектного
 *     `<проект>/.opencode/plugins/`. Панель ведёт их как файловый менеджер —
 *     ровно так же, как каталог правил Cursor (список, чтение, создание,
 *     изменение, удаление), с той же защитой путей.
 *  2. **NPM-ПАКЕТЫ** — массив `plugin` в `opencode.json`: `["opencode-wakatime",
 *     "@my-org/custom-plugin"]`. Ключ подтверждён и документацией, и
 *     опубликованной схемой конфигурации, поэтому список правится.
 *
 * Записи расширенной формы (`[имя, {настройки}]`) панель не ведёт: их формы
 * документация не описывает. Они сохраняются как есть и показываются только для
 * чтения.
 */

/** Формат раздела плагинов (пока только OpenCode). */
export const providerPluginsFormats = ['opencode-plugins'] as const;
export type ProviderPluginsFormat = (typeof providerPluginsFormats)[number];

/** Уровень: глобальный каталог/конфиг или проектный. */
export const providerPluginsScopes = ['global', 'project'] as const;
export type ProviderPluginsScope = (typeof providerPluginsScopes)[number];

/** Один файл плагина в каталоге. */
export const providerPluginFileSchema = object({
  /** Путь ОТНОСИТЕЛЬНО каталога плагинов, разделитель `/` (`git/notify.ts`). */
  path: string(),
  /** Абсолютный путь файла — пользователь всегда видит, что правит. */
  fullPath: string(),
  /** Размер файла в байтах. */
  size: number(),
});

export type ProviderPluginFile = Infer<typeof providerPluginFileSchema>;

/**
 * Запись массива `plugin`, которую панель не ведёт: пара «имя + объект
 * настроек». Идентичность у неё одна — позиция в массиве.
 */
export const providerPluginPreservedEntrySchema = object({
  index: number(),
  value: string(),
});

export type ProviderPluginPreservedEntry = Infer<typeof providerPluginPreservedEntrySchema>;

/**
 * Сводка раздела плагинов. Две независимые половины (файлы и npm-список) могут
 * быть доступны по-разному: каталог читается, а конфиг сломан — тогда
 * `packagesReadOnly` = true, но файлами по-прежнему можно управлять.
 */
export const providerPluginsInfoSchema = object({
  providerId: string(),
  providerName: string(),
  format: zodEnum(providerPluginsFormats),
  scope: zodEnum(providerPluginsScopes),

  /** Абсолютный путь каталога файлов-плагинов. */
  pluginsDir: string(),
  /** Каталог уже существует на диске. */
  dirExists: boolean(),
  /** Файлы плагинов (`.js`/`.ts`/`.mjs`), включая вложенные, по алфавиту. */
  files: array(providerPluginFileSchema),
  /** Файлы каталога, которые панель не ведёт (чужое расширение). */
  ignored: array(providerPluginFileSchema),
  /** Каталог не читается → файловая половина только для чтения. */
  filesReadOnly: boolean().default(false),
  /** Текст ошибки, если каталог не читается. */
  filesError: string().optional(),

  /** Абсолютный путь конфигурации, в которой лежит массив `plugin`. */
  configPath: string(),
  /** Ключ `plugin` в файле есть. */
  packagesPresent: boolean(),
  /** Имена npm-пакетов простой формы, в порядке файла. */
  packages: array(string()),
  /** Записи расширенной формы — сохраняются как есть. */
  preservedPackages: array(providerPluginPreservedEntrySchema),
  /** Конфиг не разобран → список npm только для чтения. */
  packagesReadOnly: boolean().default(false),
  /** Текст ошибки, если конфиг не разобран. */
  packagesError: string().optional(),
});

export type ProviderPluginsInfo = Infer<typeof providerPluginsInfoSchema>;

/** Один файл плагина целиком (содержимое как есть, ничем не разбирается). */
export const providerPluginFileContentSchema = object({
  path: string(),
  fullPath: string(),
  content: string(),
});

export type ProviderPluginFileContent = Infer<typeof providerPluginFileContentSchema>;

/**
 * Тело запроса на создание/обновление файла плагина. Путь задаётся ОТНОСИТЕЛЬНО
 * каталога плагинов — сервер отдельно проверяет, что он никуда из каталога не
 * выходит и оканчивается на `.js`, `.ts` или `.mjs`.
 */
export const providerPluginFileDraftSchema = object({
  path: string(),
  content: string(),
});

export type ProviderPluginFileDraft = Infer<typeof providerPluginFileDraftSchema>;

/**
 * Тело запроса на запись списка npm-плагинов. Список передаётся ЦЕЛИКОМ; пустой
 * означает «ключа `plugin` в файле быть не должно» (ключ удаляется, а не пишется
 * пустым массивом).
 */
export const providerPluginPackagesDraftSchema = object({
  packages: array(string()),
});

export type ProviderPluginPackagesDraft = Infer<typeof providerPluginPackagesDraftSchema>;
