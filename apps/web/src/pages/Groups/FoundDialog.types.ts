import type { DiscoveredGroup } from '@agentdeck/contracts';

export interface FoundDialogProps {
  found: DiscoveredGroup;
  onClose: () => void;
}
