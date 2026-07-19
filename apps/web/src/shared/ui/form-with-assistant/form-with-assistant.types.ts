import type { ReactNode } from 'react';

export interface FormWithAssistantProps {
  /** Поля формы — левая колонка. */
  children: ReactNode;
  /** Что заполняем: подставляется в запрос помощнику. */
  kind: string;
  fields: Record<string, unknown>;
  schema: Record<string, string>;
  onApply: (fields: Record<string, unknown>) => void;
  placeholder?: string;
}
