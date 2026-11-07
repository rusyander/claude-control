import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';

// Сеть подменена на границе: `apiClient` отдаёт число страницы и запоминает конверт команды.
const get = vi.fn(async () => ({ data: { nonce: 'n-1', expiresAt: 0 } }));
const post = vi.fn(async (_url: string, _body: unknown) => ({ data: { status: 'applied' } }));
vi.mock('@shared/api/client', () => ({ apiClient: { get, post } }));

const { sendCoreCommand } = await import('./coreApi');

/**
 * Ключ повтора команды держит вызывающий (запуск группы, P47): повтор после ответа, которого
 * не было, уходит тем же `cmdId`, и ядро отдаёт сохранённый исход, а не исполняет второй раз.
 * Без ключа у черновика — новый на каждую отправку.
 */
describe('sendCoreCommand — ключ повтора', () => {
  beforeEach(() => post.mockClear());

  const sentEnvelope = (): CommandEnvelope => post.mock.calls[0]?.[1] as unknown as CommandEnvelope;

  it('cmdId черновика уходит в конверт как есть', async () => {
    await sendCoreCommand({ kind: 'launch', taskId: 't-1', fields: {}, cmdId: 'cmd-keep-7' });

    expect(post.mock.calls[0]?.[0]).toBe('/core/commands');
    expect(sentEnvelope().cmdId).toBe('cmd-keep-7');
    expect(sentEnvelope().target).toEqual({ taskId: 't-1' });
    expect(sentEnvelope().proof.nonce).toBe('n-1');
  });

  it('без cmdId у черновика — свой новый ключ', async () => {
    await sendCoreCommand({ kind: 'launch', taskId: 't-1', fields: {} });

    expect(sentEnvelope().cmdId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
