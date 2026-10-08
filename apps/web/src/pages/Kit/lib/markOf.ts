import type { KitItem } from '@agentdeck/contracts/kit';
import { MARK_TONE } from '../KitGlobalActions/KitGlobalActions.constants';

export function markOf(twin: KitItem['conflict']): keyof typeof MARK_TONE {
  if (!twin) return 'absent';
  return twin.same ? 'same' : 'differs';
}
