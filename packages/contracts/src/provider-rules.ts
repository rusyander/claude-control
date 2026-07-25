import { object, string, array, boolean, number, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Инструкции-КАТАЛОГОМ ПРАВИЛ — ТРЕТЬЯ модель раздела «Глобальные инструкции».
 *
 * Первые две уже есть:
 *  - `file` — ОДИН файл целиком (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`);
 *  - `list` — СПИСОК ССЫЛОК на файлы (Aider: ключ `read` в `.aider.conf.yml`).
 *
 * У Cursor не подходит ни та, ни другая. По документации его правила — это
 * КАТАЛОГ файлов `.mdc`: глобальный `~/.cursor/rules/`, проектный
 * `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются
 * (`.cursor/rules/frontend/react.mdc`). Каждый файл `.mdc` = YAML-frontmatter +
 * markdown-тело, а frontmatter несёт три задокументированных поля:
 *
 *  - `description` — краткое описание правила;
 *  - `globs` — шаблоны файлов/каталогов, при совпадении с которыми правило
 *    подключается (несколько шаблонов разделяются запятыми);
 *  - `alwaysApply` — булево: подключать правило в КАЖДЫЙ разговор.
 *
 * ВАЖНО ПРО `.md`: обычный markdown-файл без frontmatter Cursor в каталоге
 * правил ИГНОРИРУЕТ. Панель показывает такие файлы отдельным списком «Cursor их
 * не читает» и НИКОГДА их не правит — молча выдавать их за правила было бы
 * обманом.
 */

/**
 * Формат каталога правил:
 * - `cursor-mdc` — Cursor, файлы `.mdc` (обычный `.md` в каталоге правил Cursor
 *   ИГНОРИРУЕТ);
 * - `continue-md` — Continue, файлы `.md` в `<проект>/.continue/rules`. Тот же
 *   frontmatter (`globs`, `alwaysApply`, `description`) плюс СВОЙ ключ `name`,
 *   которым панель не управляет: он сохраняется как чужой ключ.
 */
export const providerRulesFormats = ['cursor-mdc', 'continue-md'] as const;
export type ProviderRulesFormat = (typeof providerRulesFormats)[number];

/** Уровень каталога правил: глобальный (`~`) или каталог проекта. */
export const providerRulesScopes = ['global', 'project'] as const;
export type ProviderRulesScope = (typeof providerRulesScopes)[number];

/**
 * Почему правило показано только для чтения:
 * - `malformed` — frontmatter есть, но не разбирается как YAML-отображение либо
 *   поле имеет неожиданный тип (`alwaysApply` не булево и т.п.);
 * - `no_frontmatter` — frontmatter отсутствует вовсе. Для `.mdc` это значит, что
 *   Cursor правило не подхватит; переписывать такой файл вслепую панель не станет.
 */
export const providerRuleProblemSchema = zodEnum(['malformed', 'no_frontmatter']);
export type ProviderRuleProblem = Infer<typeof providerRuleProblemSchema>;

/** Одна строка списка правил каталога. */
export const providerRuleSummarySchema = object({
  /** Путь ОТНОСИТЕЛЬНО каталога правил, разделитель `/` (`frontend/react.mdc`). */
  path: string(),
  /** Абсолютный путь файла на диске — пользователь всегда видит, что правит. */
  fullPath: string(),
  /** Поле `description` frontmatter, если оно есть. */
  description: string().optional(),
  /** Поле `globs` frontmatter (шаблоны через запятую), если оно есть. */
  globs: string().optional(),
  /** Поле `alwaysApply` frontmatter — правило подключается в каждый разговор. */
  alwaysApply: boolean().optional(),
  /** Размер файла в байтах. */
  size: number(),
  /** Frontmatter разобран и понят панелью (иначе правило только для чтения). */
  frontmatterOk: boolean(),
  /** Что именно не так с frontmatter, если `frontmatterOk` = false. */
  problem: providerRuleProblemSchema.optional(),
});

export type ProviderRuleSummary = Infer<typeof providerRuleSummarySchema>;

/**
 * Файл в каталоге правил, который Cursor ИГНОРИРУЕТ, потому что это не `.mdc`
 * (обычный `.md`, `.txt`, что угодно). Показываем честно и не трогаем никогда.
 */
export const providerRulesIgnoredFileSchema = object({
  /** Путь относительно каталога правил, разделитель `/`. */
  path: string(),
  /** Абсолютный путь файла. */
  fullPath: string(),
  /** Размер файла в байтах. */
  size: number(),
});

export type ProviderRulesIgnoredFile = Infer<typeof providerRulesIgnoredFileSchema>;

/**
 * Ответ раздела правил-каталога. `readOnly` = true, когда сам каталог прочитать
 * не удалось: писать вслепую нельзя (fail-closed), раздел уходит в режим чтения.
 */
export const providerRulesInfoSchema = object({
  /** Id активного провайдера (`cursor`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера. */
  providerName: string(),
  /** Формат каталога правил. */
  format: zodEnum(providerRulesFormats),
  /** Уровень: глобальный каталог или каталог проекта. */
  scope: zodEnum(providerRulesScopes),
  /** Абсолютный путь каталога правил (`~/.cursor/rules`). */
  rulesDir: string(),
  /** Каталог уже существует на диске. */
  dirExists: boolean(),
  /** Правила `.mdc` — включая вложенные в подкаталоги, в алфавитном порядке. */
  rules: array(providerRuleSummarySchema),
  /** Файлы каталога, которые Cursor не читает (не `.mdc`). */
  ignored: array(providerRulesIgnoredFileSchema),
  /** Каталог не читается → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если каталог не читается. */
  error: string().optional(),
});

export type ProviderRulesInfo = Infer<typeof providerRulesInfoSchema>;

/** Одно правило целиком: три поля frontmatter отдельно от markdown-тела. */
export const providerRuleSchema = object({
  /** Путь относительно каталога правил, разделитель `/`. */
  path: string(),
  /** Абсолютный путь файла. */
  fullPath: string(),
  /** Поле `description` frontmatter. */
  description: string().optional(),
  /** Поле `globs` frontmatter (шаблоны через запятую). */
  globs: string().optional(),
  /** Поле `alwaysApply` frontmatter. */
  alwaysApply: boolean().optional(),
  /**
   * Markdown-тело правила (всё после закрывающего `---`). При нераспознанном
   * frontmatter здесь лежит ВЕСЬ файл как есть — чтобы можно было прочитать
   * содержимое, ничего не переписывая.
   */
  body: string(),
  /** Ключи frontmatter, которыми панель не управляет (сохраняются при записи). */
  otherKeys: array(string()),
  /** Правило только для чтения (frontmatter не разобран). */
  readOnly: boolean().default(false),
  /** Что именно не так с frontmatter, если правило только для чтения. */
  problem: providerRuleProblemSchema.optional(),
});

export type ProviderRule = Infer<typeof providerRuleSchema>;

/**
 * Тело запроса на создание/обновление правила. Путь задаётся ОТНОСИТЕЛЬНО
 * каталога правил (`frontend/react.mdc`) — сервер отдельно проверяет, что он
 * никуда из каталога не выходит и оканчивается на `.mdc`.
 *
 * Пустые `description`/`globs` и не заданный `alwaysApply` означают «ключа во
 * frontmatter быть не должно»: значений по умолчанию панель молча не пишет.
 */
export const providerRuleDraftSchema = object({
  path: string(),
  description: string().optional(),
  globs: string().optional(),
  alwaysApply: boolean().optional(),
  body: string(),
});

export type ProviderRuleDraft = Infer<typeof providerRuleDraftSchema>;
