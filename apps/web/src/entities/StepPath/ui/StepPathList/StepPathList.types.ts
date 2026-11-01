import type { ReactNode, Ref } from 'react';

export interface StepPathListProps {
  listRef: Ref<HTMLOListElement>;
  /** Доступное имя списка: по нему список находят и чтение с экрана, и проверки. */
  label: string;
  children: ReactNode;
}
