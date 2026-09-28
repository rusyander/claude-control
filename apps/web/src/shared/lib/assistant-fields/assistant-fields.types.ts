/**
 * Описание поля формы для помощника: какого оно вида и из чего выбирать.
 * Одно описание даёт и задание модели (`assistantSchema`), и проверку ответа
 * (`readAssistantFields`) — они не могут разъехаться.
 */

/** Допустимое значение перечислимого поля: что писать в ответ и как это зовут. */
export interface AssistantOption {
  value: string;
  /** Подпись для модели — имя сущности, путь, заголовок. */
  label?: string;
}

interface AssistantFieldBase {
  /** Назначение поля для модели — по-английски (задание модели, D-E). */
  hint: string;
  /**
   * Поле сейчас закрыто (файл переменной при правке, имя созданного скилла):
   * модели не предлагается, а присланное значение не применяется и называется.
   */
  off?: boolean;
}

/** Строка. Число и логическое значение приводятся к строке. */
export interface AssistantTextSpec extends AssistantFieldBase {
  type: 'text';
}

/** Одно значение из списка (выпадающий список, кнопки-варианты). */
export interface AssistantChoiceSpec extends AssistantFieldBase {
  type: 'choice';
  options: readonly AssistantOption[];
}

/** Несколько значений из списка, порядок значим (отметки, выбор проектов). */
export interface AssistantChoicesSpec extends AssistantFieldBase {
  type: 'choices';
  options: readonly AssistantOption[];
}

/** Свободный список строк (фильтры хука, аргументы). */
export interface AssistantListSpec extends AssistantFieldBase {
  type: 'list';
  /** Примеры, которые знает форма; значения вне них тоже принимаются. */
  suggestions?: readonly string[];
}

/** Число. `nullable` — `null` сбрасывает поле к умолчанию. */
export interface AssistantNumberSpec extends AssistantFieldBase {
  type: 'number';
  integer?: boolean;
  min?: number;
  max?: number;
  nullable?: boolean;
}

/** Переключатель. */
export interface AssistantFlagSpec extends AssistantFieldBase {
  type: 'flag';
}

export type AssistantFieldSpec =
  | AssistantTextSpec
  | AssistantChoiceSpec
  | AssistantChoicesSpec
  | AssistantListSpec
  | AssistantNumberSpec
  | AssistantFlagSpec;

export type AssistantSpec = Record<string, AssistantFieldSpec>;

/** Вид значения поля после проверки. */
export type AssistantValueOf<F extends AssistantFieldSpec> = F extends { type: 'text' | 'choice' }
  ? string
  : F extends { type: 'choices' | 'list' }
    ? string[]
    : F extends { type: 'number' }
      ? number | null
      : boolean;

/** Проверенные значения: только поля, которые можно применить. */
export type AssistantValues<S extends AssistantSpec> = {
  [K in keyof S]?: AssistantValueOf<S[K]>;
};

/**
 * Что из ответа не применено и почему:
 * `unknown-value` — такого в панели нет (`values` — что именно),
 * `wrong-type` — значение не того вида, `unknown-field` — у формы нет такого
 * поля, `locked` — поле сейчас закрыто, `secret` — модель переписала маску
 * секрета, и сервер не смог вернуть его на место: поле оставлено как было.
 */
export interface AssistantMiss {
  field: string;
  reason: 'unknown-value' | 'wrong-type' | 'unknown-field' | 'locked' | 'secret';
  values?: string[];
}

export interface AssistantReading<S extends AssistantSpec> {
  values: AssistantValues<S>;
  /** Поля, которые применяются, — в порядке ответа. */
  applied: Array<keyof S & string>;
  missed: AssistantMiss[];
}

/** Итог применения — его рисует лента помощника. */
export interface AssistantApplyReport {
  applied: string[];
  missed: AssistantMiss[];
}

/** Реплика окна помощника в теле запроса: сессии у помощника нет. */
export interface AssistTurn {
  role: 'user' | 'assistant';
  text: string;
}
