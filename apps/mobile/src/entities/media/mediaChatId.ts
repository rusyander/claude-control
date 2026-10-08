/** Разговор, к которому привязать картинку: у черновика `new-*` его ещё нет. */
export function mediaChatId(chatId: string): string {
  return chatId.startsWith('new-') ? '' : chatId;
}
