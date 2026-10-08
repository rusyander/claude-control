import type { PortabilityLevel } from '@entities/Portability';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';

export interface PickerOption {
  value: string;
  label: string;
}

export interface PortabilityPickerProps {
  providerId: string;
  onProvider: (value: string) => void;
  providerOptions: PickerOption[];
  /** Поле цели — только на вкладках, где речь о цели. */
  showTarget: boolean;
  target: string;
  onTarget: (value: string) => void;
  targetOptions: PickerOption[];
  scope: PortabilityLevel['scope'];
  onScope: (value: PortabilityLevel['scope']) => void;
  project: string;
  onProject: (value: string) => void;
  projectOptions: PickerOption[];
  levelReady: boolean;
  /** Сводка паспорта — только на его вкладке. */
  passport: AgentEnvironment | undefined;
}
