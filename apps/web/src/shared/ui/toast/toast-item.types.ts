import type { ToastItem } from '@shared/lib/toast';

export interface ToastItemProps {
  toast: ToastItem;
  /** Закрыть тост по кнопке или по истечении времени. */
  onDismiss: (id: string) => void;
}
