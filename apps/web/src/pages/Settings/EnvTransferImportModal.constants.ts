import type { BadgeTone } from '@shared/ui/badge';
import type { EnvTransferEntryStatus } from './EnvTransfer.types';

/** Цвет записи плана: перезапись — предупреждение, нерешённая — отказ. */
export const STATUS_TONE: Record<EnvTransferEntryStatus, BadgeTone> = {
  new: 'success',
  same: 'neutral',
  differs: 'warning',
  unresolved: 'danger',
};
