import type { SplitGroupCleaned } from '@agentdeck/contracts/chat-handoff';

export interface GroupCopyCleanupProps {
  /** Родитель разделения — ключ записи конвейера, которой адресуется уборка. */
  parentChatId: string;
  /** Номер группы в конвейере. */
  index?: number;
  /**
   * Чат группы прошлого разделения (F5.2): её номер от старого плана и занят
   * новой группой, поэтому адрес — чат. Есть — номер не нужен.
   */
  chatId?: string;
  /** Копия уже убрана — вместо кнопки строка с итогом по ветке. */
  cleaned?: SplitGroupCleaned['branch'];
}
