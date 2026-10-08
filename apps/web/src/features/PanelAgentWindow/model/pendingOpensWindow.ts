/**
 * Открывает ли пришедшая карточка окно. Только своя: чужая (другая вкладка,
 * телефон, второе окно) видна на значке кнопки — на узком экране окно закрывало
 * страницу, на которой человек работал, ради просьбы, которую он не задавал.
 */
export function pendingOpensWindow(
  card: { conversationId?: string },
  isOwn: (conversationId: string | undefined) => boolean,
): boolean {
  return isOwn(card.conversationId);
}
