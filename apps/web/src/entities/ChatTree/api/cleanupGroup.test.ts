import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';
import { queryClient } from '@app/queryClient';
import { apiClient } from '@shared/api/client';
import { cleanupGroupMutation } from './ChatTreeApi';

/**
 * Уборка копии (Д19) на настоящем общем клиенте запросов. Группа прошлого
 * разделения (F5.2) адресуется чатом: её номер от старого плана занят новой
 * группой, и по номеру ушла бы не та копия.
 */
describe('убрать копию группы', () => {
  afterEach(() => vi.restoreAllMocks());

  const run = async (input: Parameters<typeof cleanupGroupMutation.mutationFn>[0]) => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { at: '2026-09-26T10:00:00.000Z', branch: 'kept' } });
    const observer = new MutationObserver(queryClient, {
      ...cleanupGroupMutation,
      meta: { silentError: true },
    });
    await observer.mutate(input);
    return post;
  };

  it('группа нынешнего плана — по номеру', async () => {
    const post = await run({ parentChatId: 'родитель 1', index: 2 });

    expect(post).toHaveBeenCalledWith(`/chat/split/${encodeURIComponent('родитель 1')}/cleanup`, {
      index: 2,
    });
  });

  it('группа прошлого разделения — по чату, без номера', async () => {
    const post = await run({ parentChatId: 'родитель 1', chatId: 'старый-чат' });

    expect(post).toHaveBeenCalledWith(`/chat/split/${encodeURIComponent('родитель 1')}/cleanup`, {
      chatId: 'старый-чат',
    });
  });
});
