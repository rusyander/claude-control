import type { SplitGroupStatusView } from '@agentdeck/contracts/chat-handoff';

/** Статусы групп дерева: `<корень>#<номер группы>` → статус. */
export type GroupSnapshot = Map<string, SplitGroupStatusView>;

export interface GroupEvent {
  kind: 'groupFailed' | 'groupStopped' | 'groupDelivered';
  /** Корень дерева — разговор с хабом, куда ведёт кнопка реплики. */
  root: string;
  index: number;
  title: string;
}
