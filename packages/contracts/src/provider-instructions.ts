import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Инструкции-СПИСКОМ ССЫЛОК — вторая модель раздела «Глобальные инструкции».
 *
 * У Claude/Codex/Gemini/OpenCode инструкции это ОДИН файл (`CLAUDE.md`,
 * `AGENTS.md`, `GEMINI.md`) — его обслуживает `InstructionsFileInfo`.
 *
 * У Aider единого файла инструкций НЕТ. По документации подключение файлов
 * контекста делается опцией `read` в `.aider.conf.yml` — это СПИСОК путей
 * (`read: [CONVENTIONS.md, anotherfile.txt]`, допустима и форма маркированным
 * списком, и одиночная строка). То есть управлять надо не «файлом инструкций», а
 * ССЫЛКАМИ на файлы в конфиге. Отсюда своя модель: список записей + возможность
 * править содержимое той записи, файл которой реально существует.
 *
 * Панель НЕ выдумывает файлов: записи берутся только из `read`, содержимое
 * правится только у существующего текстового файла, а сам список пишется через
 * Document API пакета `yaml` — комментарии, порядок и прочие ключи конфига целы.
 */

/** Формат конфигурации, в которой лежит список ссылок (пока только Aider). */
export const providerInstructionsFormats = ['aider-yaml'] as const;
export type ProviderInstructionsFormat = (typeof providerInstructionsFormats)[number];

/** Уровень конфигурации: глобальный файл в домашнем каталоге или файл проекта. */
export const providerInstructionsScopes = ['global', 'project'] as const;
export type ProviderInstructionsScope = (typeof providerInstructionsScopes)[number];

/** Одна запись списка `read`: как записана в конфиге и во что разрешается. */
export const providerInstructionsEntrySchema = object({
  /** Значение ровно так, как оно записано в конфиге (может быть относительным). */
  raw: string(),
  /** Абсолютный путь, в который панель разрешает запись (от каталога конфига). */
  path: string(),
  /** Файл существует на диске. */
  exists: boolean(),
  /** Содержимое можно открыть и править в панели (существует, текстовый, не огромный). */
  editable: boolean(),
  /**
   * Почему запись не редактируется: `missing` (файла нет — панель его НЕ создаёт),
   * `binary` (не текстовый файл), `too_large` (больше лимита), `directory`,
   * `unsafe_path` (запись проектного конфига ведёт ЗА пределы проекта — панель
   * туда не пишет, даже если файл существует; называть это `missing` значило бы
   * предлагать создать уже существующий файл).
   */
  reason: zodEnum(['missing', 'binary', 'too_large', 'directory', 'unsafe_path']).optional(),
});

export type ProviderInstructionsEntry = Infer<typeof providerInstructionsEntrySchema>;

/**
 * Ответ раздела инструкций-ссылок. `readOnly` = true, когда конфиг не разбирается
 * как YAML-отображение либо `read` имеет неожиданную форму (не строка и не список
 * строк): править вслепую нельзя — раздел уходит в режим чтения (fail-closed).
 */
export const providerInstructionsInfoSchema = object({
  /** Id активного провайдера (`aider`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера. */
  providerName: string(),
  /** Формат конфигурации со списком ссылок. */
  format: zodEnum(providerInstructionsFormats),
  /** Уровень: глобальный конфиг или конфиг проекта. */
  scope: zodEnum(providerInstructionsScopes),
  /** Абсолютный путь конфигурации, где лежит список (`~/.aider.conf.yml`). */
  configPath: string(),
  /** Конфигурация уже существует на диске. */
  configExists: boolean(),
  /** Каталог, относительно которого разрешаются относительные записи списка. */
  baseDir: string(),
  /** Записи списка `read` в порядке их следования в файле. */
  entries: array(providerInstructionsEntrySchema),
  /** Формат не распознан → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если формат не распознан. */
  error: string().optional(),
});

export type ProviderInstructionsInfo = Infer<typeof providerInstructionsInfoSchema>;

/**
 * Тело запроса на сохранение списка: полный желаемый набор записей В ПОРЯДКЕ
 * отображения. Добавление, удаление и перестановка на клиенте сводятся к одному
 * PUT — сервер пишет ровно этот список в ключ `read`.
 */
export const providerInstructionsDraftSchema = object({
  entries: array(string()),
});

export type ProviderInstructionsDraft = Infer<typeof providerInstructionsDraftSchema>;

/** Содержимое ОДНОГО файла из списка (открывается только для существующей записи). */
export const providerInstructionsFileSchema = object({
  /** Запись списка, по которой открыт файл. */
  raw: string(),
  /** Абсолютный путь открытого файла. */
  path: string(),
  /** Текст файла. */
  content: string(),
});

export type ProviderInstructionsFile = Infer<typeof providerInstructionsFileSchema>;
