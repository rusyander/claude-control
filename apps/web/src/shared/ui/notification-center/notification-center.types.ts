import type { ToastTone } from '@shared/lib/toast';
import type { IconName } from '@shared/ui/icon';

export interface NotificationCenterProps {
  /**
   * Панель свёрнута: подпись у колокольчика прячется, остаётся один значок.
   * Нужен, потому что колокольчик живёт в боковой панели рядом с разделами.
   */
  isCollapsed?: boolean;
}

/** Значок под каждый тон — тот же набор, что и у самих тостов. */
export const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'error',
  warning: 'warning',
  info: 'info',
};
