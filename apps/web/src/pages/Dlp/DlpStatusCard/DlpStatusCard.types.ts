import type { DlpSettings, DlpStatus, EndpointProfile } from '@agentdeck/contracts';

export interface Props {
  settings: DlpSettings;
  status: DlpStatus;
  profiles: EndpointProfile[];
  canStart: boolean;
  isBusy: boolean;
  onChange: (patch: Partial<DlpSettings>) => void;
  onToggleRunning: (running: boolean) => void;
}
