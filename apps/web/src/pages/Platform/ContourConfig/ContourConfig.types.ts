import type { PlatformStatus, PlatformConsumerOption } from '@agentdeck/contracts';

export interface ContourConfigProps {
  status: PlatformStatus;
  options: readonly PlatformConsumerOption[] | undefined;
  filesApplied: boolean;
}
