import type { DiscoveredIntegration } from '@agentdeck/contracts';

export interface DiscoveredItemProps {
  item: DiscoveredIntegration;
  isSelected: boolean;
  onToggle: () => void;
}
