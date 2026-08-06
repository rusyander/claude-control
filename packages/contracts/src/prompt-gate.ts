import { object, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Гейт на промпте: хук `UserPromptSubmit`, который смотрит на текст ДО отправки.
 *
 * Самый слабый из трёх механизмов панели, и панель обязана говорить это первой:
 * хук видит РОВНО то, что человек набрал руками. Файлы, которые агент прочитал
 * сам, вывод команд, содержимое инструментов, вложения — всё это идёт в модель
 * мимо него. Ставят его не вместо прокси, а рядом: он отвечает на «случайно
 * вставил в окно чата», и только на это.
 *
 * Замены меткой здесь нет и быть не может: `UserPromptSubmit` по документации
 * не умеет подменять промпт — только остановить отправку (код возврата 2) или
 * добавить сообщение. Выдумывать несуществующее поле панель не станет.
 */

/** Что делать при совпадении. Замены нет — событие её не поддерживает. */
export const promptGateActions = ['block', 'warn'] as const;
export type PromptGateAction = (typeof promptGateActions)[number];

export const promptGateSettingsSchema = object({
  enabled: boolean().default(false),
  /**
   * `block` — отправка останавливается, человек правит текст сам.
   * `warn` — отправка идёт, но с предупреждением.
   *
   * Правило с действием «отклонить» останавливает промпт при ЛЮБОМ из двух:
   * оно означает «этого не должно уходить вовсе», и понижать его до
   * предупреждения общей настройкой нельзя.
   */
  action: zodEnum(promptGateActions).default('block'),
});

export type PromptGateSettings = Infer<typeof promptGateSettingsSchema>;

/** Ответ `GET /api/prompt-gate`: настройки плюс что реально лежит на диске. */
export interface PromptGateInfo {
  settings: PromptGateSettings;
  /** Скрипт лежит на месте И зарегистрирован в settings.json. */
  installed: boolean;
  /** Путь к скрипту — его видно в разделе хуков как обычный хук. */
  scriptPath: string;
  /** Команда запуска, как она записана в settings.json. */
  command: string;
  /** Файл на диске отличается от того, что сгенерировала бы панель. */
  customized: boolean;
  /** Сколько включённых правил увидит хук (правила общие с прокси). */
  rulesCount: number;
  /** Из них с действием «отклонить» — эти останавливают промпт всегда. */
  blockRulesCount: number;
  /** Почему состояние неполное: правила не читаются, скрипт пропал. */
  problem?: string;
}
