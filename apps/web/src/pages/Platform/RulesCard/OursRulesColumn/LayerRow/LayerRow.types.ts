import type { OurLayerId, Platform, OurRules } from '@agentdeck/contracts';

export interface LayerRowProps {
  id: OurLayerId;
  platform: Platform;
  ours: OurRules;
  update: (next: Platform) => void;
}
