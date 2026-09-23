import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { apiClient } from '@shared/api/client';
import { agentRuns, getRun } from './agentRunsStore';

/**
 * Новый ход разговора, начатый НЕ этим табом: сам CLI (кончилась фоновая
 * задача агента — живая сессия продолжает работу без сообщения человека),
 * телефон или соседнее окно. Прежде `/chat/active` пропускал такой прогон,
 * раз ключ разговора уже знаком табу, и лента молчала до перезагрузки.
 */

function stream(frames: string[], open: boolean, init?: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const encoder = new TextEncoder();
      for (const frame of frames) ctrl.enqueue(encoder.encode(`${frame}\n\n`));
      if (!open) ctrl.close();
      init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason), {
        once: true,
      });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('новый ход под знакомым ключом', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('закрытый у нас разговор с новым ходом на сервере снова «работает» и читает поток с начала', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream(
          [
            'data: {"kind":"session","sessionId":"sess-7","model":"m","tools":0,"startedAt":1000,"seq":1}',
            'data: {"kind":"text","text":"первый","seq":2}',
            'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"sess-7","seq":3}',
          ],
          false,
        ),
      ),
    );
    void agentRuns.start({ chatId: 'new-7', prompt: 'WAKE' });
    await settle();
    expect(getRun('new-7').status).not.toBe('running');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      stream(['data: {"kind":"text","text":"проснулся"}'], true, init),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
      url === '/chat/active'
        ? {
            data: [
              {
                chatId: 'new-7',
                sessionId: 'sess-7',
                seq: 2,
                startedAt: 2000,
                status: 'running',
              },
            ],
          }
        : { data: [] },
    );

    await agentRuns.resumeActive();
    await settle();

    const run = getRun('new-7');
    expect(run.status).toBe('running');
    expect(run.startedAt).toBe(2000);
    expect(run.text).toBe('проснулся');
    // Буфер нового прогона свой: номер прошлого хода отрезал бы его начало.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('from=0');

    agentRuns.stop('new-7');
    agentRuns.clear('new-7');
  });

  it('тот же ход, закрытый у нас на мгновение раньше сервера, заново не открывается', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream(
          [
            'data: {"kind":"session","sessionId":"sess-5","model":"m","tools":0,"startedAt":1000}',
            'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"sess-5"}',
          ],
          false,
        ),
      ),
    );
    void agentRuns.start({ chatId: 'new-5', prompt: 'привет' });
    await settle();

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => stream([], true, init));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
      url === '/chat/active'
        ? {
            data: [
              { chatId: 'new-5', sessionId: 'sess-5', seq: 2, startedAt: 1000, status: 'running' },
            ],
          }
        : { data: [] },
    );

    await agentRuns.resumeActive();
    await settle();

    expect(getRun('new-5').status).not.toBe('running');
    expect(fetchMock).not.toHaveBeenCalled();
    agentRuns.clear('new-5');
  });
});
