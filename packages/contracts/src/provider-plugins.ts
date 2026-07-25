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

/**
 * У Kimi Code плагины устроены ТРЕТЬИМ способом, и он только для чтения
 * (KIMI-3). Задокументировано: плагин ставится в
 * `$KIMI_CODE_HOME/plugins/managed/<id>/`, его манифест — JSON
 * (`kimi.plugin.json` либо `.kimi-plugin/plugin.json`), а СПИСОК установленного
 * и признак «включён» лежат в `plugins/installed.json`, форма которого
 * документацией НЕ описана. Ставят, включают и выключают плагины командой
 * `/plugins` в самом CLI.
 *
 * Поэтому панель показывает установленные плагины (что это, что они приносят —
 * скиллы, MCP-серверы, хуки, команды) и НИЧЕГО в них не пишет: угадывать форму
 * реестра запрещено тем же правилом, по которому панель перестала писать
 * `experimental.hook` у OpenCode.
 */

/** Формат раздела плагинов: файлы+npm у OpenCode, список установленного у Kimi. */
export const providerPluginsFormats = ['opencode-plugins', 'kimi-plugins'] as const;
export type ProviderPluginsFormat = (typeof providerPluginsFormats)[number];

/**
 * Половины раздела. У OpenCode их две (`files` + `packages`), у Kimi одна
 * (`installed`) — интерфейс рисует ровно то, что назвал сервер.
 */
export const providerPluginsSections = ['files', 'packages', 'installed'] as const;
export type ProviderPluginsSection = (typeof providerPluginsSections)[number];

/** Установленный плагин Kimi: манифест, прочитанный только для показа. */
export const providerInstalledPluginSchema = object({
  /** Имя каталога в `plugins/managed/` — оно же id для команд `/plugins`. */
  id: string(),
  /** Абсолютный путь манифеста (или каталога, если манифест не найден). */
  manifestPath: string(),
  /** Поле `name` манифеста. */
  name: string().optional(),
  version: string().optional(),
  description: string().optional(),
  /** `interface.displayName` — как плагин называется в списке `/plugins`. */
  displayName: string().optional(),
  /** Манифест объявляет каталог скиллов. */
  hasSkills: boolean(),
  /** Скилл, который плагин подгружает в начале сессии (`sessionStart.skill`). */
  sessionStartSkill: string().optional(),
  /** Имена MCP-серверов из манифеста. */
  mcpServers: array(string()),
  /** Сколько правил-хуков объявляет манифест. */
  hookCount: number(),
  /** Манифест регистрирует слэш-команды. */
  hasCommands: boolean(),
  /** Манифест не найден или не разобран — плагин показан одним именем каталога. */
  error: string().optional(),
});

export type ProviderInstalledPlugin = Infer<typeof providerInstalledPluginSchema>;

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
  /** Какие половины раздела вообще есть у этого формата. */
  sections: array(zodEnum(providerPluginsSections)).default(['files', 'packages']),

  /** Абсолютный путь каталога файлов-плагинов (у Kimi — `plugins/managed`). */
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
  configPath: string().optional(),
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

  /** Установленные плагины (Kimi) — только показ, панель их не меняет. */
  installed: array(providerInstalledPluginSchema).default([]),
  /** Абсолютный путь реестра `installed.json` — чтобы было видно, где он. */
  installedRegistryPath: string().optional(),
  /** Каталог установленного не читается — текст ошибки. */
  installedError: string().optional(),
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
