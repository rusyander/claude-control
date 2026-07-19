import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Кнопки действий раздела — обычно «создать» и «обновить». */
  actions?: ReactNode;
}
