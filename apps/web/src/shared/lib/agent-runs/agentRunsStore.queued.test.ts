import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Отправка занятому разговору с `queueIfBusy` (W3-5): сервер ставит сообщение
 * в свою очередь и отвечает 202 с ключом идущего прогона. Для вкладки это
 * «принято» (поле ввода очищается), и она подключается к идущему прогону —
 * а не читает JSON-ответ как поток и не объявляет отказ.
 */

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function queuedResponse(runId: string): Response {
  const text = JSON.stringify({ queued: true, runId });
  return new Response(text, { status: 202, headers: { 'Content-Type': 'application/json' } });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns.start — сообщение в очереди сервера', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('202: отправка принята, вкладка подключается к идущему прогону по его ключу', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/chat/send')) return queuedResponse('run-busy-9');
      return sseResponse(['data: {"kind":"text","text":"ещё отвечаю","seq":1}']);
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await agentRuns.start({
      chatId: 'q-1',
      sessionId: 'q-1',
      prompt: 'ответ человека',
      queueIfBusy: true,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(outcome).toEqual({ ok: true, queued: true });
    const sent = fetchMock.mock.calls.find((call) => String(call[0]).includes('/chat/send'));
    expect(JSON.parse(String((sent?.[1] as RequestInit).body))).toMatchObject({
      queueIfBusy: true,
    });
    const stream = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('/stream'));
    expect(stream).toContain('/chat/run-busy-9/stream');
    expect(getRun('q-1').error).toBeUndefined();
    expect(getRun('q-1').text).toContain('ещё отвечаю');

    agentRuns.stop('q-1');
  });
});
