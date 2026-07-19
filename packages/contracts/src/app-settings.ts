import { object, string, boolean, enum as zodEnum, type infer as Infer } from 'zod';

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
  /** Следить за файлами и обновлять интерфейс при внешних изменениях. */
  watchFiles: boolean().default(true),
  /** Крупнее шрифт и заметнее фокус — для доступности. */
  largeText: boolean().default(false),
  /** Отключить анимации: для чувствительных к движению и слабых машин. */
  reduceMotion: boolean().default(false),
  /** Усиленный контраст интерфейса. */
  highContrast: boolean().default(false),
});

export type AppSettings = Infer<typeof appSettingsSchema>;
