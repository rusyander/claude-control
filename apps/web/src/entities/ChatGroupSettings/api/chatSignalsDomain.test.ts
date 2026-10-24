import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { DOMAIN_KEYS, queryKeys } from '@shared/api/query-keys';

/**
 * Сторож записал или закрыл сигнал одиночного чата — сервер шлёт домен
 * `chat-signals`, и FileWatchProvider сбрасывает по нему ключи из `DOMAIN_KEYS`.
 * Без записи там фишка строки и остров над лентой ждали бы F5.
 */
describe('домен chat-signals — сигналы одиночных чатов перечитываются по событию сервера', () => {
  it('ключи домена сбрасывают список сигналов', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.chatWatchSignals, { signals: {} });
    for (const key of DOMAIN_KEYS['chat-signals'] ?? []) {
      await client.invalidateQueries({ queryKey: key });
    }
    expect(client.getQueryState(queryKeys.chatWatchSignals)?.isInvalidated).toBe(true);
  });
});
