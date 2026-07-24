import { object, string, array, enum as zodEnum, boolean, type infer as Infer } from 'zod';

/**
 * Универсальная модель переменной окружения провайдера — общий межвендорный
 * субсет: имя ключа и значение.
 *
 * Разные CLI хранят переменные окружения по-разному (Claude — объект `env` в
 * settings.json, Codex — таблица `[shell_environment_policy.set]` в config.toml,
 * Aider — список `set-env` в `~/.aider.conf.yml`, элементы вида `КЛЮЧ=значение`,
 * Gemini — обычный файл `.env` в `~/.gemini/` и в `<проект>/.gemini/`).
 * Раздел Claude остаётся на своей богатой модели `EnvVar` (источники settings/
 * settings-local/secrets, маскирование, перенос). Эта модель — базовый KV для
 * провайдеров с реализованным адаптером формата (Codex, Aider, Gemini).
 */
export const providerEnvVarSchema = object({
  /** Имя переменной — оно же идентификатор. */
  key: string(),
  /** Значение переменной (plain-текст, как хранится в конфиге провайдера). */
  value: string(),
});

export type ProviderEnvVar = Infer<typeof providerEnvVarSchema>;

/** Формат файла переменных окружения провайдера. */
export const providerEnvFormats = ['toml', 'aider-yaml', 'dotenv'] as const;
export type ProviderEnvFormat = (typeof providerEnvFormats)[number];

/**
 * Ответ раздела универсальных переменных окружения провайдера (Codex, Aider,
 * Gemini). Помимо самого списка несёт метаданные для адаптации интерфейса:
 * формат файла, путь, обнаружен ли CLI и данные активного провайдера.
 *
 * `readOnly` = true, когда формат файла не распознан (config.toml не парсится,
 * регион `shell_environment_policy` неоднозначен, `~/.aider.conf.yml` не
 * разбирается как YAML-отображение, строка `.env` не является ни комментарием,
 * ни присваиванием): раздел показывается только на чтение, запись запрещена
 * (fail-closed).
 */
export const providerEnvInfoSchema = object({
  vars: array(providerEnvVarSchema),
  /** Id активного провайдера (`codex` / `aider` / `gemini`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера — для заголовка раздела. */
  providerName: string(),
  /**
   * Формат файла: `toml` (Codex config.toml), `aider-yaml` (~/.aider.conf.yml)
   * или `dotenv` (Gemini `.env`).
   */
  format: zodEnum(providerEnvFormats),
  /** Абсолютный путь к файлу конфигурации переменных окружения активного провайдера. */
  filePath: string(),
  /** Обнаружен ли CLI провайдера (по наличию его каталога конфигурации). */
  cliDetected: boolean(),
  /** Формат не распознан → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если формат не распознан. */
  error: string().optional(),
});

export type ProviderEnvInfo = Infer<typeof providerEnvInfoSchema>;

/**
 * Тело запроса на сохранение переменных окружения провайдера: полный желаемый
 * набор пар ключ→значение. Раздел записывает ровно этот набор в `set` (bulk
 * replace) — добавление/правка/удаление на клиенте сводятся к одному PUT.
 */
export const providerEnvDraftSchema = object({
  vars: array(providerEnvVarSchema),
});

export type ProviderEnvDraft = Infer<typeof providerEnvDraftSchema>;
