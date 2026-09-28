import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { chatTreeKeys } from '@entities/ChatTree';
import { apiClient } from '@shared/api/client';
import { splitTasksOptions, type SplitTasksBody } from './ChatSplitApi';

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
