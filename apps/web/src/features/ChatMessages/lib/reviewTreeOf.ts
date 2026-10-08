import type { ReviewDecisionItem } from '../ui/ReviewDecisionCard.types';

/**
 * Дерево, которому адресуется решение: сервер проверяет по нему, что группа
 * действительно оттуда, — клик из вкладки, помнящей чужое разделение, до групп
 * не доходит.
 */
export function reviewTreeOf(
  items: readonly ReviewDecisionItem[],
  chatId: string,
  fallback: (string | undefined)[],
): string {
  const known = items.find((item) => item.chatId === chatId)?.parentChatId;
  return known ?? fallback.find(Boolean) ?? '';
}
