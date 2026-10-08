import type { GlobalLayerVerdict, GlobalLayerSide } from '@agentdeck/contracts';
import type { BadgeTone } from '@shared/ui/badge';

export const VERDICT_TONE: Record<GlobalLayerVerdict, BadgeTone> = {
  panel: 'accent',
  global: 'info',
  equal: 'neutral',
};

export const SIDES: readonly GlobalLayerSide[] = ['panel', 'global'];
