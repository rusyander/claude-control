import type { SplitGroupCleaned } from '@agentdeck/contracts/chat-handoff';

export interface GroupCopyCleanupProps {
  /** Родитель разделения — ключ записи конвейера, которой адресуется уборка. */
  parentChatId: string;
  /** Номер группы в конвейере. */
  index: number;
  /** Копия уже убрана — вместо кнопки строка с итогом по ветке. */
  cleaned?: SplitGroupCleaned['branch'];
}
