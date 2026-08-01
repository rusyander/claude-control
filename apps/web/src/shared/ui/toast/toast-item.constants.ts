import type { ToastTone } from '@shared/lib/toast';

/**
 * Роль для скринридера: ошибки/предупреждения читаются немедленно (`alert`),
 * успех и справка — не перебивая (`status`). Так уведомление доступно и без
 * зрения, а важное не теряется в потоке.
 */
export const TONE_ROLE: Record<ToastTone, 'alert' | 'status'> = {
  success: 'status',
  error: 'alert',
  warning: 'alert',
  info: 'status',
};

/** Появление снизу вверх, уход — вбок к краю, откуда тост «выезжал». */
export const TOAST_VARIANTS = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, x: 24, scale: 0.98 },
};
