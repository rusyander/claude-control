import { describe, it, expect, vi } from 'vitest';

const post = vi.fn();

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: (...args: unknown[]) => post(...args),
    get: vi.fn(async () => ({ data: [] })),
  },
  // Перевод по коду — как у настоящего клиента: код есть — строка языка
  // интерфейса, нет — запасной `message`.
  messageFromPayload: (payload: { messageCode?: string; message?: string }) =>
    payload.messageCode ? `translated:${payload.messageCode}` : payload.message,
}));

import { agentRuns } from './agentRunsStore';

/**
 * Отказ выбора стороны ветки без исключения (`{ok:false}` в теле 200) — текст
 * тем же путём, что у отказа с исключением: по коду сервера на языке
 * интерфейса, а не сырой русский `message` (F-336).
 */
describe('decideBranchGate: отказ в теле ответа', () => {
  it('текст по коду сервера, а не сырой message', async () => {
    post.mockResolvedValueOnce({
      data: { ok: false, message: 'Сырой русский текст', messageCode: 'gate-gone' },
    });
    const answer = await agentRuns.decideBranchGate('run-x', 'tool-1', 'here');
    expect(answer).toEqual({ ok: false, error: 'translated:gate-gone' });
  });

  it('без текста — отказ без строки', async () => {
    post.mockResolvedValueOnce({ data: { ok: false } });
    expect(await agentRuns.decideBranchGate('run-x', 'tool-2', 'here')).toEqual({ ok: false });
  });
});
