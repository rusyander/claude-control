import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface SplitTicketsProps {
  /** Группы записи разделения: предложения тикетов живут в них. */
  groups: SplitPlanView['groups'];
  /** Родитель разделения — адрес ручки «Завести». */
  parentChatId: string;
  /** Проект трекера, куда тикет можно завести; нет — только «Копировать». */
  tracker?: string;
}
