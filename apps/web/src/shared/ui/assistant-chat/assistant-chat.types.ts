import type { AssistantApplyReport, AssistantMiss } from '@shared/lib/assistant-fields';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Имена картинок, ушедших с репликой человека. */
  images?: string[];
  /** Какие поля формы изменил этот ответ — показывается списком под текстом. */
  changedFields?: string[];
  /** Ответ не пришёл (ошибка CLI): в историю следующего запроса не идёт. */
  failed?: boolean;
  /** Что из ответа не применено и почему — называется под текстом, а не теряется молча. */
  missed?: AssistantMiss[];
}

export interface AssistantChatProps {
  /** Что заполняем: подставляется в запрос, чтобы модель понимала контекст. */
  kind: string;
  /** Текущее содержимое формы. */
  fields: Record<string, unknown>;
  /** Описание полей: имя → назначение. Модель заполняет только эти поля. */
  schema: Record<string, string>;
  /**
   * Применить предложенные значения к форме. Отчёт (что применено, что
   * отброшено) рисуется под ответом; без отчёта полями считаются ключи ответа.
   */
  onApply: (fields: Record<string, unknown>) => AssistantApplyReport | void;
  /** Подсказка в пустом чате: пример запроса для этого раздела. */
  placeholder?: string;
  /**
   * Списки, из которых модель выбирает значения, ещё не пришли. Отправка
   * закрыта: задание, собранное по пустым спискам, говорит модели «вариантов
   * нет», и она честно не выбирает ничего.
   */
  loading?: boolean;
}
