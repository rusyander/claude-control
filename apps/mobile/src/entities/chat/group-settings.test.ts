import { describe, expect, it, vi } from 'vitest';
import type { ChatEscalationsView } from '@agentdeck/contracts/chat-group-settings';

vi.mock('../../shared/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const { unreadEscalations } = await import('./unreadEscalations');

const entry = (id: string, read = false) => ({
  id,
  childChatId: 'kid',
  childTitle: 'Группа API',
  text: 'Миграция удалит колонку',
  source: 'block' as const,
  at: '2026-09-26T10:00:00.000Z',
  read,
});

describe('unreadEscalations — заметки главного чата на телефоне', () => {
  it('берёт непрочитанные по обоим ключам разговора без повторов', () => {
    const view: ChatEscalationsView = {
      chats: { 'new-1': [entry('a')], sess: [entry('a'), entry('b'), entry('c', true)] },
    };
    expect(unreadEscalations(view, ['new-1', 'sess']).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('чужой чат и пустой вид — пусто', () => {
    expect(unreadEscalations({ chats: { other: [entry('x')] } }, ['mine', undefined])).toEqual([]);
    expect(unreadEscalations(undefined, ['mine'])).toEqual([]);
  });
});
