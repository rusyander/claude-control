import type { InboxChatStatus, InboxChat } from '@agentdeck/contracts/chat-inbox';

/**
 * Главный экран телефона: что идёт и кто ждёт человека — по всем проектам.
 * Здесь только разбор ответа сервера (`GET /chat/inbox`), без React: его и
 * проверяют тесты.
 */

/** Ждущие наверх, за ними идущие, молчащие последними. */
export const STATUS_RANK: { [key in InboxChatStatus]: number } = {
  waiting: 0,
  running: 1,
  idle: 2,
};

export function byImportance(a: InboxChat, b: InboxChat): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}
