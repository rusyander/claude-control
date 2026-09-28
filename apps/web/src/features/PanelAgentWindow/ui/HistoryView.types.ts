export interface HistoryViewProps {
  onOpen: (conversationId: string) => void;
  /** Идёт ход: другой разговор не открывается, иначе ход оборвался бы молча. */
  isBusy: boolean;
  /** Разговор, открытый сейчас в окне: удалив его, окно начинает новый. */
  currentId?: string;
  onDeleted: (conversationId: string) => void;
}
