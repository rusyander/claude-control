import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Очередь дописанного. Смысл её в том, что задача может идти часами: пока агент
 * занят, сказать ему «заодно посмотри вот это» было нельзя — оставалось либо
 * ждать конца, либо убивать прогон и начинать заново.
 */

/** Поток SSE из готовых кадров: отдаёт их разом и закрывается. */
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

const DONE = 'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"s-1","seq":1}';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns — очередь дописанного', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => sseResponse([DONE]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('дописанное уходит само, когда текущий ход закончился', async () => {
    void agentRuns.start({ chatId: 'q-1', prompt: 'первое' });
    agentRuns.enqueue('q-1', { prompt: 'второе' });
    await settle();

    // Два запроса: исходный и дослан из очереди; очередь пуста.
    const prompts = fetchMock.mock.calls
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
      .filter((body) => body.includes('prompt'));
    expect(prompts.some((body) => body.includes('первое'))).toBe(true);
    expect(prompts.some((body) => body.includes('второе'))).toBe(true);
    expect(getRun('q-1').queued).toHaveLength(0);
  });

  it('очередь уходит по одному сообщению за ход, в порядке добавления', async () => {
    void agentRuns.start({ chatId: 'q-2', prompt: 'первое' });
    agentRuns.enqueue('q-2', { prompt: 'второе' });
    agentRuns.enqueue('q-2', { prompt: 'третье' });
    await settle();

    const order = fetchMock.mock.calls
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''))
      .filter((body) => body.includes('prompt'));
    const second = order.findIndex((body) => body.includes('второе'));
    const third = order.findIndex((body) => body.includes('третье'));
    expect(second).toBeGreaterThanOrEqual(0);
    expect(third).toBeGreaterThan(second);
  });

  it('передумал — сообщение снимается из очереди и не уходит', async () => {
    void agentRuns.start({ chatId: 'q-3', prompt: 'первое' });
    const queuedId = agentRuns.enqueue('q-3', { prompt: 'ненужное' });
    agentRuns.cancelQueued('q-3', queuedId);
    await settle();

    const bodies = fetchMock.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? ''),
    );
    expect(bodies.some((body) => body.includes('ненужное'))).toBe(false);
  });

  /**
   * Регрессия, ради которой очередь и гасится в `stop`: иначе «Остановить»
   * останавливало текущий ход, а следом само поднимало агента дописанным — то
   * есть кнопка не останавливала ничего.
   */
  it('«Остановить» гасит очередь, а не досылает её следом', async () => {
    // Поток держим открытым, чтобы остановка застала прогон живым.
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({ start() {} }),
        }) as unknown as Response,
    );

    void agentRuns.start({ chatId: 'q-4', prompt: 'первое' });
    agentRuns.enqueue('q-4', { prompt: 'дописанное' });
    await settle();

    agentRuns.stop('q-4');
    await settle();

    const bodies = fetchMock.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? ''),
    );
    expect(bodies.some((body) => body.includes('дописанное'))).toBe(false);
    expect(getRun('q-4').queued).toHaveLength(0);
  });
});
