import type { ReactNode } from 'react';
import type { AssistantSpec, AssistantValues } from '@shared/lib/assistant-fields';

export interface FormWithAssistantProps<S extends AssistantSpec> {
  /** Поля формы — левая колонка. */
  children: ReactNode;
  /** Что заполняем: подставляется в запрос помощнику. */
  kind: string;
  /** Текущее содержимое формы — модель дополняет, а не затирает. */
  fields: Record<string, unknown>;
  /**
   * Каждое поле, которое может задать человек: вид значения, допустимые
   * значения (id + подпись) у перечислимых. Из него строится задание модели и
   * им же проверяется ответ.
   */
  spec: S;
  /** Применить уже проверенные значения — только принятые поля. */
  onApply: (values: AssistantValues<S>) => void;
  placeholder?: string;
  /** Допустимые значения ещё грузятся — помощник ждёт их, а не шлёт пустые списки. */
  loading?: boolean;
}
