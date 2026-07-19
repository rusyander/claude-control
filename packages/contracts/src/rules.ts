import { object, string, array, boolean, number, type infer as Infer } from 'zod';

/**
 * Правило из CLAUDE.md. Файл — обычный markdown, правила в нём разделены
 * заголовками второго уровня. Приложение разбирает файл на правила, чтобы
 * их можно было включать, группировать и редактировать по отдельности,
 * и собирает обратно при сохранении — сам файл остаётся читаемым markdown.
 */
export const ruleSchema = object({
  /** Слаг из заголовка — стабилен, пока заголовок не переименован. */
  id: string(),
  /** Текст заголовка без префикса «ПРАВИЛО:». */
  title: string(),
  /** Тело правила в markdown. */
  body: string(),
  /** Порядковый номер в файле — правила показываются в том же порядке. */
  order: number(),
  /**
   * Выключенное правило не удаляется, а переносится в раздел
   * «Отключённые правила» в конце файла — Claude его не читает как активное.
   */
  isEnabled: boolean(),
  groupIds: array(string()),
  /** Область действия: глобальный CLAUDE.md или файл конкретного проекта. */
  scope: string(),
});

export type Rule = Infer<typeof ruleSchema>;

export const ruleDraftSchema = object({
  title: string().min(1),
  body: string(),
  isEnabled: boolean().default(true),
  groupIds: array(string()).default([]),
});

export type RuleDraft = Infer<typeof ruleDraftSchema>;
