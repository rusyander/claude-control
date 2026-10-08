import type { ProviderCheckStatus } from '@agentdeck/contracts';
import type { TrustTone } from './trust.types';

/** Тон значка шага — тот же язык цветов, что и у бейджа целиком. */
export function stepTone(status: ProviderCheckStatus): TrustTone {
  if (status === 'pass') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'danger';
  return 'neutral';
}
