import type { LocalJob } from '@agentdeck/contracts/local-models';

export interface JobProgressProps {
  job: LocalJob;
  onCancel?: () => void;
}
