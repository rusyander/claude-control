import type { ChildStageGroup } from './ChildStages.types';

export interface RetiredChatsProps {
  /** Строки отброшенных перезапуском чатов (`retired`). */
  chats: ChildStageGroup[];
  /** Открыть чат в этом же окне — как строку группы. */
  onOpen: (chatId: string) => void;
}
