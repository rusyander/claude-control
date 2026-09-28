import type { DiscoveredGroup } from '@agentdeck/contracts';

export interface FoundTileProps {
  found: DiscoveredGroup;
  onOpen: () => void;
}
