import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface SplitFollowUpsProps {
  split: SplitPlanView;
  /** Открыты ли разделы при первом показе; по умолчанию свёрнуты. */
  defaultExpanded?: boolean;
  /** Открыть чат в этом же окне: «взято в чат» и «Решить здесь». */
  onOpen?: (chatId: string) => void;
  /** Дерево ведёт чужой CLI: «Решить здесь» запускает только Claude. */
  foreign?: boolean;
}
