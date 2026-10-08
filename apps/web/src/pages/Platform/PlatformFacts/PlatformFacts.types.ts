import type { PlatformStatus } from '@agentdeck/contracts';

export interface PlatformFactsProps {
  platforms: PlatformStatus[];
  compromisesTotal: number;
}
