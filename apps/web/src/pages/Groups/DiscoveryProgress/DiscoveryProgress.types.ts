import type { DiscoverySourceResult, DiscoveryView } from '@agentdeck/contracts';

export interface DiscoveryProgressProps {
  view: DiscoveryView;
}

export interface DiscoverySourceRowProps {
  source: DiscoverySourceResult;
}
