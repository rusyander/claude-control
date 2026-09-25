import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Код известной ошибки CLI доезжает из кадра потока до прогона (живой прогон
 * 25.09.2026: переполненный родитель и устаревший CLI показывались сырой
 * строкой API). Поток — настоящий разбор SSE стора; подменён только сетевой ответ.
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}`;

describe('ошибка CLI с кодом', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('код, версии и переполнение — в прогоне; сам не повторяет; «Закрыть» снимает всё', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        frame({
          kind: 'error',
          message: 'Prompt is too long · … Claude Code 2.1.278 does not support this model',
          seq: 1,
          retriable: false,
          code: 'cli-outdated',
          params: { current: '2.1.278', required: '2.1.280' },
          overflow: true,
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await agentRuns.start({ chatId: 'cli-err-1', prompt: 'как дела у групп?' });
    await settle();

    expect(getRun('cli-err-1')).toMatchObject({
      errorCode: 'cli-outdated',
      errorParams: { current: '2.1.278', required: '2.1.280' },
      errorOverflow: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    agentRuns.dismissError('cli-err-1');

    expect(getRun('cli-err-1').errorCode).toBeUndefined();
    expect(getRun('cli-err-1').errorOverflow).toBeUndefined();
  });

  it('ошибка без кода — ни кода, ни переполнения', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([frame({ kind: 'error', message: 'упал', seq: 1 })])),
    );

    await agentRuns.start({ chatId: 'cli-err-2', prompt: 'сделай' });
    await settle();

    expect(getRun('cli-err-2').error).toBe('упал');
    expect(getRun('cli-err-2').errorCode).toBeUndefined();
    expect(getRun('cli-err-2').errorOverflow).toBeUndefined();
  });
});
