import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { publishSplitTicketsMutation, takeSplitTicketsMutation } from './SplitTicketBatchApi';

/** «Разобрать…»: запросы уходят по адресу родителя с телом, которое ждёт сервер. */
describe('«Разобрать…» — запросы', () => {
  afterEach(() => vi.restoreAllMocks());

  it('«Опубликовать в Jira» — проект, тип, язык и повтор упавших; адрес родителя закодирован', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { issues: [], failed: [], mode: 'model' } });
    const observer = new MutationObserver(new QueryClient(), publishSplitTicketsMutation);

    await observer.mutate({
      parentChatId: 'родитель 1',
      projectKey: 'PROJ',
      issueType: 'Bug',
      lang: 'ru',
      retryFailed: true,
    });

    expect(post).toHaveBeenCalledWith(
      `/chat/split/${encodeURIComponent('родитель 1')}/tickets/publish`,
      { projectKey: 'PROJ', issueType: 'Bug', lang: 'ru', retryFailed: true },
    );
  });

  it('«Решить здесь» — только язык', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { chatId: 'new-1', count: 2 } });
    const observer = new MutationObserver(new QueryClient(), takeSplitTicketsMutation);

    const result = await observer.mutate({ parentChatId: 'p', lang: 'en' });

    expect(result).toEqual({ chatId: 'new-1', count: 2 });
    expect(post).toHaveBeenCalledWith('/chat/split/p/tickets/take', { lang: 'en' });
  });
});
