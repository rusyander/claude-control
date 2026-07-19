import type { ReactNode } from 'react';

export interface ModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Кнопки внизу окна: сохранить, отменить, удалить. */
  footer?: ReactNode;
  /** xl — для форм с помощником: поля и чат в две колонки. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}
