import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface SplitTicketsProps {
  /** Группы записи разделения: предложения тикетов живут в них. */
  groups: SplitPlanView['groups'];
  /** Родитель разделения — адрес ручки «Завести». */
  parentChatId: string;
  /** Проект трекера, куда тикет можно завести; нет — только «Копировать». */
  tracker?: string;
  /** Открыт ли список при первом показе; по умолчанию свёрнут. */
  defaultExpanded?: boolean;
  /** Открыть чат в этом же окне: «взято в чат» и «Решить здесь». */
  onOpen?: (chatId: string) => void;
  /** Дерево ведёт чужой CLI: «Решить здесь» запускает только Claude. */
  foreign?: boolean;
}
