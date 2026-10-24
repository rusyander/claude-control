import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { DOMAIN_KEYS } from '@shared/api/query-keys';
import { chatTreeKeys } from './ChatTreeApi';

/**
 * F-62: сторож групп записал сигналы — сервер шлёт домен `chat-tree`, и
 * FileWatchProvider сбрасывает по нему ключи из `DOMAIN_KEYS`. Без записи там
 * событие доходило до вкладки и ничего не перечитывало: сигнал ждал опроса.
 */
describe('домен chat-tree — дерево разговора перечитывается по событию сервера', () => {
  it('ключи домена сбрасывают открытое дерево любого разговора', async () => {
    const client = new QueryClient();
    client.setQueryData(chatTreeKeys.tree('parent'), { ok: true });
    for (const key of DOMAIN_KEYS['chat-tree'] ?? []) {
      await client.invalidateQueries({ queryKey: key });
    }
    expect(client.getQueryState(chatTreeKeys.tree('parent'))?.isInvalidated).toBe(true);
  });
});
