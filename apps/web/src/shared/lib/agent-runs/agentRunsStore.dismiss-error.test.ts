import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getChatStatuses, getRun } from './agentRunsStore';

/**
 * «Закрыть» на карточке ошибки. Регрессия, ради которой написано: карточка
 * «Агент остановился с ошибкой» висела красной, пока человек не нажмёт
 * «Повторить» или «Продолжить», — отказаться от упавшего запроса было нельзя.
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

describe('agentRuns.dismissError', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('снимает ошибку, красную точку и упавший запрос — повторять нечего', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(['data: {"kind":"error","message":"Prompt is too long","seq":1}']),
    );
    vi.stubGlobal('fetch', fetchMock);

    await agentRuns.start({ chatId: 'dismiss-1', prompt: 'продолжи' });
    await settle();
    expect(getRun('dismiss-1').error).toBe('Prompt is too long');
    expect(getRun('dismiss-1').status).toBe('error');
    expect(getChatStatuses().get('dismiss-1')).toBe('error');

    agentRuns.dismissError('dismiss-1');

    const run = getRun('dismiss-1');
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('idle');
    expect(run.lastPrompt).toBeUndefined();
    expect(getChatStatuses().get('dismiss-1')).not.toBe('error');

    // Запрос отменён целиком: «Повторить» после закрытия ничего не шлёт.
    const calls = fetchMock.mock.calls.length;
    await agentRuns.retry('dismiss-1');
    await settle();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('прогон без ошибки не трогает', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['data: {"kind":"done","seq":1}'])),
    );
    await agentRuns.start({ chatId: 'dismiss-2', prompt: 'привет' });
    await settle();
    const before = getRun('dismiss-2');

    agentRuns.dismissError('dismiss-2');

    expect(getRun('dismiss-2')).toBe(before);
  });
});
