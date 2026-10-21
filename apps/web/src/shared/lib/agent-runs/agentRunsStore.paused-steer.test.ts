import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns } from './agentRunsStore';

/**
 * Карточка 33 прогона 20.10: ответ на вопрос группы ушёл из хаба «на ходу»
 * (202 steered), вкладка подцепилась к идущему прогону ребёнка. Через полчаса
 * «Пауза» группы остановила прогон — сервер закрыл поток без итогового
 * события. Ответ уже у агента: второй раз его отправлять нельзя.
 */

function streamThenCut(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns — ответ, переданный на ходу, после остановки прогона извне', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('пауза рвёт поток — вкладка не отправляет ответ второй раз', async () => {
    let streams = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/chat/send')) {
        return new Response(JSON.stringify({ steered: true, runId: 'grp-run' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      streams += 1;
      // Первый поток — идущий ход; дальше прогона на сервере уже нет.
      if (streams === 1) return streamThenCut(['data: {"kind":"text","text":"работаю","seq":1}']);
      // Сервер на поток ушедшего прогона отвечает 200 и сразу закрывает (`ChatStream`).
      return streamThenCut([': open']);
    });
    vi.stubGlobal('fetch', fetchMock);

    await agentRuns.start({
      chatId: 'grp-1',
      sessionId: 'grp-1',
      prompt: '«Сбой провайдера» (Рекомендую)',
      queueIfBusy: true,
      steer: true,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    const sends = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/chat/send'));
    expect(sends).toHaveLength(1);
    agentRuns.stop('grp-1');
  });
});
