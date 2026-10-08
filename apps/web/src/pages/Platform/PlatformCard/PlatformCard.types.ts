import type { PlatformStatus } from '@agentdeck/contracts';

export interface PlatformCardProps {
  status: PlatformStatus;
  onEdit: () => void;
}
