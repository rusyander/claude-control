import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { chatTreeKeys } from '@entities/ChatTree';
import { queryClient } from '@app/queryClient';
import { apiClient } from '@shared/api/client';
import { clearToasts, getToasts } from '@shared/lib/toast';
import { splitTasksMutation, splitTasksOptions, type SplitTasksBody } from './ChatSplitApi';

/**
 * Живой прогон 25.09 (D2): на 409 «план ещё идёт» вставали два тоста — сырой
 * текст сервера из общего MutationCache и предложение отменить план от вызова.
 * Проверяется настоящий общий клиент запросов: отказ разбирает вызов, а общий
 * тост молчит.
 */
describe('разделение — отказ сервера', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearToasts();
  });

  it('общий тост ошибки не встаёт — отказ показывает вызов', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('Разделение этого разговора ещё идёт'));
    const observer = new MutationObserver(queryClient, splitTasksMutation);

    await observer.mutate({} as SplitTasksBody).catch(() => undefined);

    expect(observer.getCurrentResult().isError).toBe(true);
    expect(getToasts()).toEqual([]);
  });
});

/**
 * Живой прогон 26.09 (D1): после 200 кнопка «Разделить» оживала, пока дерево
 * с новым планом не перечитано. Запрос держится идущим до нового дерева.
 */
describe('разделение — замок до нового дерева', () => {
  afterEach(() => vi.restoreAllMocks());

  it('isPending падает, когда дерево уже перечитано', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { chats: [], failures: [] } });
    const client = new QueryClient();
    let version = 0;
    const tree = new QueryObserver(client, {
      queryKey: chatTreeKeys.tree('parent-1'),
      queryFn: async () => {
        await new Promise((done) => setTimeout(done, 50));
        version += 1;
        return { version };
      },
    });
    const unsubscribe = tree.subscribe(() => undefined);
    await vi.waitFor(() => expect(tree.getCurrentResult().data).toEqual({ version: 1 }));
    const mutation = new MutationObserver(client, splitTasksOptions(client));

    await mutation.mutate({} as SplitTasksBody);

    expect(mutation.getCurrentResult().isPending).toBe(false);
    expect(tree.getCurrentResult().data).toEqual({ version: 2 });
    unsubscribe();
  });
});
