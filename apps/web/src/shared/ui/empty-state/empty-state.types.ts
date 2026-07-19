import type { ReactNode } from 'react';
import type { IconName } from '@shared/ui/icon';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  text?: string;
  /** Кнопка «создать» — необязательна: не у всякой пустоты есть действие. */
  action?: ReactNode;
}
