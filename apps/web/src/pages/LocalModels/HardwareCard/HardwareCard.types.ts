import type { HardwareInfo } from '@agentdeck/contracts/local-models';

export interface HardwareCardProps {
  hardware: HardwareInfo;
  onRefresh: () => void;
  isRefreshing: boolean;
}
