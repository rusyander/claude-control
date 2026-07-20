import { object, string, boolean, number, record, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Тариф за миллион токенов. Панель считает по нему справочную стоимость —
 * на подписке за токены не списывают, поэтому число означает «столько же
 * работы через API стоило бы вот столько».
 */
export const modelPricingSchema = object({
  input: number().nonnegative(),
  output: number().nonnegative(),
  cacheRead: number().nonnegative(),
  cacheWrite: number().nonnegative(),
});

export type ModelPricing = Infer<typeof modelPricingSchema>;

/**
 * Строка прайса. Цена привязана к конкретной версии модели, а не к семейству:
 * Opus 4.1 стоит втрое дороже Opus 4.8, и считать их одной ценой — врать в разы.
 * Срок действия нужен ценам, которые меняются по расписанию (вводные тарифы).
 */
export interface PricingEntry {
  id: string;
  label: string;
  price: ModelPricing;
  /** Действует с этой даты (YYYY-MM-DD). */
  from?: string;
  /** Действует по эту дату включительно (YYYY-MM-DD). */
  until?: string;
}

/**
 * Ответ `/api/analytics/pricing`: актуальный прайс и свои цены пользователя.
 * `source` и `fetchedAt` показывают, насколько ценам можно верить — панель
 * обязана это отображать, иначе стоимость снова окажется посчитанной по
 * прошлогоднему прайсу молча.
 */
export interface AnalyticsPricing {
  entries: PricingEntry[];
  /** `anthropic` — прайс с сайта, `built-in` — запасная таблица в коде. */
  source: 'anthropic' | 'built-in';
  fetchedAt: string;
  url: string;
  /** Прайс старше суток либо ни разу не загружался. */
  stale: boolean;
  custom: Record<string, ModelPricing>;
}

export const themeSchema = zodEnum(['light', 'dark', 'system']);
export type Theme = Infer<typeof themeSchema>;

export const languageSchema = zodEnum(['ru', 'en']);
export type Language = Infer<typeof languageSchema>;

/** Настройки самого приложения — хранятся отдельно от конфигов Claude Code. */
export const appSettingsSchema = object({
  theme: themeSchema.default('system'),
  language: languageSchema.default('ru'),
  /**
   * Ручной путь к каталогу .claude. Пустая строка — определять автоматически.
   * Заполняется, когда автоопределение не сработало или каталог нестандартный.
   */
  claudeDirOverride: string().default(''),
  /** Показывать значения секретов сразу, без клика по «глазу». */
  revealSecretsByDefault: boolean().default(false),
  /** Делать резервную копию файла перед каждой записью. */
  backupBeforeWrite: boolean().default(true),
  /**
   * Сколько резервных копий одного файла хранить (ротация). Больше — глубже
   * история отката; меньше — меньше копий, в том числе секретов, на диске.
   */
  backupKeep: number().int().min(1).max(100).default(10),
  /** Следить за файлами и обновлять интерфейс при внешних изменениях. */
  watchFiles: boolean().default(true),
  /** Крупнее шрифт и заметнее фокус — для доступности. */
  largeText: boolean().default(false),
  /** Отключить анимации: для чувствительных к движению и слабых машин. */
  reduceMotion: boolean().default(false),
  /** Усиленный контраст интерфейса. */
  highContrast: boolean().default(false),
  /**
   * Команда редактора кода для «Открыть в редакторе» (например, code, cursor,
   * webstorm). Пустая строка — брать первый найденный в системе.
   */
  editor: string().default(''),
  /** Показывать расход в токенах или в деньгах. По умолчанию — токены. */
  costUnit: zodEnum(['tokens', 'money']).default('tokens'),
  /**
   * Модель по умолчанию для чата: алиас (opus/sonnet/haiku/fable) или полное имя.
   * Пустая строка — как выберет сам Claude (у этого аккаунта это Opus 4.8, 1M).
   * Централизованный дефолт; в конкретном чате его можно переопределить локально.
   */
  chatModel: string().default(''),
  /**
   * Глубина продумывания по умолчанию для чата (--effort). Пусто — по умолчанию
   * CLI; наш дефолт — очень глубокое обдумывание (xhigh).
   */
  chatEffort: zodEnum(['', 'low', 'medium', 'high', 'xhigh', 'max']).default('xhigh'),
  /**
   * Свои тарифы: фрагмент имени модели → цена за миллион токенов. Пустой
   * объект — считать по встроенным. Заведено потому, что тарифы меняются, а
   * зашитые в код цифры устаревают молча: пользователь видит стоимость, не
   * зная, что она посчитана по прошлогоднему прайсу.
   */
  modelPricing: record(string(), modelPricingSchema).default({}),
});

export type AppSettings = Infer<typeof appSettingsSchema>;
