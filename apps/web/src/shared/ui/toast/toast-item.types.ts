import type { ToastItem } from '@shared/lib/toast';
import type { ToastDetails } from './toast-details-modal.types';

export interface ToastItemProps {
  toast: ToastItem;
  /** Закрыть тост по кнопке или по истечении времени. */
  onDismiss: (id: string) => void;
  /** Открыть окно с полным текстом — когда три строки карточки его не вмещают. */
  onShowDetails: (details: ToastDetails) => void;
}
