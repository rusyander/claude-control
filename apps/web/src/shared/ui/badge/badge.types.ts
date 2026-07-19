import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Точка-индикатор слева: используется для статусов серверов. */
  withDot?: boolean;
  className?: string;
  children: ReactNode;
}
