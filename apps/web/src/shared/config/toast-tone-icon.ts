import type { ToastTone } from '@shared/lib/toast';
import type { IconName } from '@shared/ui/icon';

/**
 * Значок под каждый тон уведомления — узнаётся мгновенно, не только по цвету.
 * Один список на всплывающий тост и на список в колокольчике: там показаны те же
 * самые уведомления, и разъехавшиеся значки читались бы как разные события.
 */
export const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'error',
  warning: 'warning',
  info: 'info',
};
