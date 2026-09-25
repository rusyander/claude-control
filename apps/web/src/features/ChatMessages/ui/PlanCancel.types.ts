import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface PlanCancelProps {
  /** План разделения из дерева: по нему решается, есть ли что отменять. */
  split: SplitPlanView;
}
