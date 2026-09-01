import type { ToastTone } from '@shared/lib/toast';

/**
 * Что показывает окно с полным текстом. Общее для живого тоста и для записи
 * журнала: у них разные источники, но читателю нужна одна и та же карточка.
 */
export interface ToastDetails {
  tone: ToastTone;
  message: string;
  title?: string;
  /** Когда уведомление появилось, мс epoch. У живого тоста времени нет. */
  at?: number;
}

export interface ToastDetailsModalProps {
  /** null — окно закрыто. */
  details: ToastDetails | null;
  onClose: () => void;
}
