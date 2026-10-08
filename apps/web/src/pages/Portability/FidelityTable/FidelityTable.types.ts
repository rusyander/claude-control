import type { FidelityAnswer } from '@agentdeck/contracts/portable-fidelity';

export interface FidelityTableProps {
  answer: FidelityAnswer;
  targetName: string;
}
