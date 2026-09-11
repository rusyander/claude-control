import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ReviewDecisionItem } from '../ui/ReviewDecisionCard.types';

/**
 * Карточки решения по ревью чужих MR (Т7) для открытого разговора.
 *
 * Показываются они в двух местах, и правило для каждого своё. РОДИТЕЛЬ — пульт:
 * ему нужны все ревью дерева, иначе ради шести одинаковых решений придётся
 * обойти шесть вкладок, от чего разделение как раз уходит. САМА ГРУППА
 * показывает только себя: карточки соседей в её ленте были бы решением о чужой
 * работе, принятым не глядя на неё.
 *
 * Состояние у обеих карточек одно — узел дерева, то есть связь чата на сервере.
 * Два источника (запись разделения и связь) разошлись бы на первом же
 * перезапуске, и человек увидел бы в хабе непринятым решение, которое он уже
 * принял в чате.
 */
export function collectReviews(input: {
  /** Дерево детей открытого разговора: он сам — родитель. */
  own?: ChatTreeView;
  /** Дерево РОДИТЕЛЯ открытого разговора: в нём лежит его собственное ревью. */
  parent?: ChatTreeView;
  /** Ключ открытого разговора — под ним же он и ищется в дереве родителя. */
  chatId?: string;
}): ReviewDecisionItem[] {
  const items: ReviewDecisionItem[] = [];
  const seen = new Set<string>();

  const add = (node: ChatTreeView['nodes'][number]): void => {
    if (!node.review || seen.has(node.chatId)) return;
    seen.add(node.chatId);
    items.push({
      chatId: node.chatId,
      ...(node.title ? { title: node.title } : {}),
      ...(node.parentChatId ? { parentChatId: node.parentChatId } : {}),
      review: node.review,
    });
  };

  for (const node of input.own?.nodes ?? []) add(node);

  // Разговор известен двумя ключами — временным `new-…` и настоящим sessionId, —
  // и вкладка может помнить любой из них: ищем по обоим.
  const mine = (input.parent?.nodes ?? []).find(
    (node) => node.chatId === input.chatId || node.aliases.includes(input.chatId ?? ''),
  );
  if (mine) add(mine);

  return items;
}

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
