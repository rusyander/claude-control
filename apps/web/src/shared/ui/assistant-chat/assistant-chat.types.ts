export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Какие поля формы изменил этот ответ — показывается списком под текстом. */
  changedFields?: string[];
}

export interface AssistantChatProps {
  /** Что заполняем: подставляется в запрос, чтобы модель понимала контекст. */
  kind: string;
  /** Текущее содержимое формы. */
  fields: Record<string, unknown>;
  /** Описание полей: имя → назначение. Модель заполняет только эти поля. */
  schema: Record<string, string>;
  /** Применить предложенные значения к форме. */
  onApply: (fields: Record<string, unknown>) => void;
  /** Подсказка в пустом чате: пример запроса для этого раздела. */
  placeholder?: string;
}
