import { object, string, array, boolean, number, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Скиллы НЕ-Claude провайдера (OPENCODE-5).
 *
 * Понятие то же, что у Claude: скилл — это ПАПКА с файлом `SKILL.md`, у которого
 * в начале YAML-frontmatter. Отличаются только каталоги и набор полей шапки.
 *
 * У OpenCode задокументированы два каталога:
 *  - глобальный `~/.config/opencode/skills/<имя>/SKILL.md`;
 *  - проектный `<проект>/.opencode/skills/<имя>/SKILL.md`.
 *
 * Полей шапки OpenCode распознаёт ровно пять: `name` (обязательное),
 * `description` (обязательное), `license`, `compatibility`, `metadata` (карта
 * строка→строка). Панель РЕДАКТИРУЕТ два обязательных; остальные ключи шапки —
 * и задокументированные, и любые чужие — она сохраняет при записи как есть и
 * показывает только для чтения. Терять то, чего не понимаешь, нельзя.
 *
 * `name` обязано СОВПАДАТЬ С ИМЕНЕМ ПАПКИ и подчиняться грамматике: 1–64 символа,
 * строчные буквы и цифры, разделитель — одиночный дефис, ни в начале, ни в конце,
 * без `--` (регулярное выражение `^[a-z0-9]+(-[a-z0-9]+)*$`). `description` —
 * 1–1024 символа. Проверка идёт ДО записи; нарушение → 400, файл не тронут.
 */

/** Формат каталога скиллов (пока только OpenCode). */
export const providerSkillsFormats = ['skill-md-dir'] as const;
export type ProviderSkillsFormat = (typeof providerSkillsFormats)[number];

/** Уровень каталога скиллов: глобальный (`~`) или каталог проекта. */
export const providerSkillsScopes = ['global', 'project'] as const;
export type ProviderSkillsScope = (typeof providerSkillsScopes)[number];

/**
 * Почему скилл показан только для чтения:
 * - `no_frontmatter` — блока `---` в начале файла нет вовсе;
 * - `malformed` — шапка есть, но не разбирается как YAML-отображение либо поле
 *   имеет неожиданный тип;
 * - `missing_name` / `missing_description` — обязательного поля нет или оно пустое.
 *
 * Во всех случаях OpenCode такой скилл не подхватит, а панель его не переписывает.
 */
export const providerSkillProblemSchema = zodEnum([
  'no_frontmatter',
  'malformed',
  'missing_name',
  'missing_description',
]);
export type ProviderSkillProblem = Infer<typeof providerSkillProblemSchema>;

/** Одна строка списка скиллов каталога. */
export const providerSkillSummarySchema = object({
  /** Имя ПАПКИ скилла — оно же его идентичность на диске. */
  dirName: string(),
  /** Путь `<папка>/SKILL.md` относительно каталога скиллов, разделитель `/`. */
  path: string(),
  /** Абсолютный путь файла `SKILL.md`. */
  fullPath: string(),
  /** Поле `name` шапки; при неразобранной шапке — имя папки. */
  name: string(),
  /** Поле `description` шапки, если оно есть. */
  description: string().optional(),
  /** Размер `SKILL.md` в байтах. */
  size: number(),
  /** Шапка разобрана и понята панелью (иначе скилл только для чтения). */
  frontmatterOk: boolean(),
  /** Что именно не так с шапкой, если `frontmatterOk` = false. */
  problem: providerSkillProblemSchema.optional(),
  /** `name` в шапке не совпадает с именем папки — OpenCode такой скилл не примет. */
  nameMismatch: boolean().default(false),
});

export type ProviderSkillSummary = Infer<typeof providerSkillSummarySchema>;

/** Папка в каталоге скиллов без `SKILL.md`: показываем честно, не трогаем никогда. */
export const providerSkillsIgnoredDirSchema = object({
  /** Имя папки относительно каталога скиллов. */
  dirName: string(),
  /** Абсолютный путь папки. */
  fullPath: string(),
});

export type ProviderSkillsIgnoredDir = Infer<typeof providerSkillsIgnoredDirSchema>;

/**
 * Каталог, из которого CLI ТОЖЕ грузит скиллы, но которым этот раздел НЕ
 * управляет. У OpenCode это `~/.claude/skills` и `~/.agents/skills`: уже готовые
 * скиллы Claude работают в нём без переноса. Панель сообщает об этом и НИЧЕГО
 * туда не пишет — скиллами Claude управляет собственный раздел Claude.
 */
export const providerSkillsExternalDirSchema = object({
  path: string(),
  exists: boolean(),
});

export type ProviderSkillsExternalDir = Infer<typeof providerSkillsExternalDirSchema>;

/**
 * Ответ раздела скиллов. `readOnly` = true, когда сам каталог прочитать не
 * удалось: писать вслепую нельзя (fail-closed), раздел уходит в режим чтения.
 */
export const providerSkillsInfoSchema = object({
  /** Id активного провайдера (`opencode`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера. */
  providerName: string(),
  /** Формат каталога скиллов. */
  format: zodEnum(providerSkillsFormats),
  /** Уровень: глобальный каталог или каталог проекта. */
  scope: zodEnum(providerSkillsScopes),
  /** Абсолютный путь каталога скиллов. */
  skillsDir: string(),
  /** Каталог уже существует на диске. */
  dirExists: boolean(),
  /** Скиллы каталога в алфавитном порядке. */
  skills: array(providerSkillSummarySchema),
  /** Папки каталога без `SKILL.md` — CLI их не подхватит, панель их не трогает. */
  ignored: array(providerSkillsIgnoredDirSchema),
  /** Каталог не читается → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если каталог не читается. */
  error: string().optional(),
  /**
   * Прочие каталоги, из которых CLI грузит скиллы (только для сведения). Пусто
   * на проектном уровне: там таких каталогов не задокументировано.
   */
  externalDirs: array(providerSkillsExternalDirSchema),
});

export type ProviderSkillsInfo = Infer<typeof providerSkillsInfoSchema>;

/** Один скилл целиком: поля шапки отдельно от markdown-тела. */
export const providerSkillSchema = object({
  /** Путь `<папка>/SKILL.md` относительно каталога скиллов. */
  path: string(),
  /** Абсолютный путь файла. */
  fullPath: string(),
  /** Имя папки скилла — с ним обязано совпадать поле `name`. */
  dirName: string(),
  /** Поле `name` шапки. */
  name: string(),
  /** Поле `description` шапки. */
  description: string(),
  /**
   * Markdown-тело скилла (всё после закрывающего `---`). При нераспознанной
   * шапке здесь лежит ВЕСЬ файл как есть — прочитать можно, переписать нельзя.
   */
  body: string(),
  /**
   * Ключи шапки, которыми панель не управляет (`license`, `compatibility`,
   * `metadata` и любые чужие). Сохраняются при записи без изменений.
   */
  otherKeys: array(string()),
  /** Скилл только для чтения (шапка не разобрана). */
  readOnly: boolean().default(false),
  /** Что именно не так с шапкой, если скилл только для чтения. */
  problem: providerSkillProblemSchema.optional(),
});

export type ProviderSkill = Infer<typeof providerSkillSchema>;

/**
 * Тело запроса на создание/обновление скилла. Путь задаётся ОТНОСИТЕЛЬНО
 * каталога скиллов и обязан иметь ровно форму `<имя>/SKILL.md`; сервер отдельно
 * проверяет, что он никуда из каталога не выходит, а `name` совпадает с `<имя>`.
 */
export const providerSkillDraftSchema = object({
  path: string(),
  name: string(),
  description: string(),
  body: string(),
});

export type ProviderSkillDraft = Infer<typeof providerSkillDraftSchema>;
