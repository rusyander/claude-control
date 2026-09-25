import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';
import { queryClient } from '@app/queryClient';
import { apiClient } from '@shared/api/client';
import { fileSplitTicketMutation } from './ChatTreeApi';

/**
 * «Завести» тикет (L277) на настоящем общем клиенте запросов: запрос уходит по
 * адресу родителя с ключом и описанием. Что отказ не даёт второго тоста,
 * проверяет общий `queryClient.double-toast.test.ts` по вызову в строке хаба.
 */
describe('завести тикет группы', () => {
  afterEach(() => vi.restoreAllMocks());

  it('запрос — по родителю, с ключом предложения и описанием', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { key: 'PROJ-7', created: true } });
    const observer = new MutationObserver(queryClient, {
      ...fileSplitTicketMutation,
      meta: { silentError: true },
    });

    const result = await observer.mutate({
      parentChatId: 'родитель 1',
      key: 'падает экспорт|a.ts:1',
      description: 'текст',
    });

    expect(result).toEqual({ key: 'PROJ-7', created: true });
    expect(post).toHaveBeenCalledWith(
      `/chat/split/${encodeURIComponent('родитель 1')}/tickets/file`,
      { key: 'падает экспорт|a.ts:1', description: 'текст' },
    );
  });
});
