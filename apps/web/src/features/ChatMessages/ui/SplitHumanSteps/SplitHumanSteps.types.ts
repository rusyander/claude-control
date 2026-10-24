import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface SplitHumanStepsProps {
  /** Группы записи разделения: шаги человеку живут в них. */
  groups: SplitPlanView['groups'];
  /** Открыт ли список при первом показе; по умолчанию свёрнут. */
  defaultExpanded?: boolean;
}
