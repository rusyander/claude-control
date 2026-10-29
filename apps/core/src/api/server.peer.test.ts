import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { DIRECT_PID, SESSION_PID, startStand, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Число страницы (половина доказательства человека) не уходит процессу из дерева сессии
 * (ревью F-05), и поток событий задачи с нечитаемым журналом отвечает причиной, а не общим
 * сбоем (ревью F-49).
 */

let stand: Stand | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await stand?.close();
  stand = undefined;
});

describe('core API: the page nonce and the session tree', () => {
  it('a caller from the session tree is refused the page nonce (403), a human caller gets it', async () => {
    stand = await startStand();
    const page = newId();
    stand.peer.direct = SESSION_PID;
    const refused = await stand.get(`/v1/nonce?page=${page}`);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('forged-authority');
    stand.peer.direct = DIRECT_PID;
    const minted = await stand.get(`/v1/nonce?page=${page}`);
    expect(minted.status).toBe(200);
    expect(((await minted.json()) as { nonce?: string }).nonce).toBeTruthy();
  });

  it('an unreadable task journal answers the events stream with 500 journal-unreadable', async () => {
    stand = await startStand();
    vi.spyOn(stand.registry, 'view').mockImplementation(() => {
      throw new Error('EBUSY: journal held by another process');
    });
    const res = await stand.get(`/v1/tasks/${stand.taskId}/events`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('journal-unreadable');
    expect(body.error).toMatch(/EBUSY/);
  });
});
