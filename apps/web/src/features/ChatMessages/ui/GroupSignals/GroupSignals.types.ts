import type { GroupSignal } from '@agentdeck/contracts/group-watch';

export interface GroupSignalsProps {
  /** Сигналы сторожа группы, новые первыми; закрытые — с `clearedAt`. */
  signals: GroupSignal[];
  /** Открыть чат звена, где правило сработало. Нет — строка без ссылки. */
  onOpen?: (chatId: string) => void;
  /**
   * Где стоит остров: `group` — карточка группы в хабе (по умолчанию), `chat` —
   * над лентой одиночного чата, без ссылки на тот же самый чат.
   */
  scope?: 'group' | 'chat';
}
