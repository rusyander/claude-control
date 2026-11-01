import type { Gate } from '@agentdeck/contracts/core/scenario';

export interface GateFieldsProps {
  gates: Gate[];
  onChange: (gates: Gate[]) => void;
}
