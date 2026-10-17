export interface StatusAskProps {
  /** Родитель разделения — ключ записи конвейера, которому адресуется вопрос. */
  parentChatId: string;
  /** Открыть заведённый лёгкий чат — тем же путём, что и звено группы. */
  onOpen: (chatId: string) => void;
}
