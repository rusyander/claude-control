import type { StepDef } from '@agentdeck/contracts/core/scenario';

export interface StepFormProps {
  step: StepDef;
  /** Номер шага в списке — заголовок формы. */
  number: number;
  onChange: (step: StepDef) => void;
}
