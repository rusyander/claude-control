import type { CalloutTone } from '../help-kit.types';
import type { IconName } from '@shared/ui/icon';

export const TONE_ICONS: Record<CalloutTone, IconName> = {
  info: 'info',
  warning: 'warning',
  danger: 'error',
  success: 'check',
};
