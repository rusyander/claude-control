import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

import { apiClient } from '@shared/api/client';
import { agentRuns, getRun } from './agentRunsStore';

/**
 * Кнопка «Остановить» против авто-рестарта.
 *
 * Регрессия, ради которой тест и написан: временная ошибка (529, «overloaded»)
 * планирует авто-перезапуск через `setTimeout`. Таймер переживал и отмену
 * потока, и сам прогон — человек нажимал «Остановить», а через пару секунд
 * агент поднимался снова и продолжал тратить токены.
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

/**
 * Временный сбой помечает СЕРВЕР флагом `retriable` — клиент текст ошибки не
 * разбирает (иначе имя вложения вроде `network.zip` выпрашивало бы ретрай).
 */
const TRANSIENT = 'data: {"kind":"error","message":"529 overloaded","retriable":true,"seq":1}';

/** Дать микрозадачам чтения потока дойти до конца. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns.stop — остановка сильнее авто-рестарта', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock = vi.fn(async () => sseResponse([TRANSIENT]));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(apiClient.post).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('после «Остановить» отложенный авто-рестарт не срабатывает', async () => {
    void agentRuns.start({ chatId: 'stop-1', prompt: 'привет' });
    await settle();
    // Прогон упал по временной причине — авто-рестарт запланирован.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    agentRuns.stop('stop-1');
    await vi.advanceTimersByTimeAsync(10_000);

    // Второго запроса нет: таймер снят, прогон не воскрес.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/chat/stop-1/stop');
  });

  it('без остановки временная ошибка перезапускает прогон сама', async () => {
    void agentRuns.start({ chatId: 'retry-1', prompt: 'привет' });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    agentRuns.stop('retry-1');
  });

  it('сервер не подтвердил остановку → ошибка видна, а не «остановлено» молча', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('Сеть недоступна'));

    void agentRuns.start({ chatId: 'stop-2', prompt: 'привет' });
    await settle();
    agentRuns.stop('stop-2');
    await settle();

    expect(getRun('stop-2').error).toContain('Сеть недоступна');
  });

  /**
   * «Остановить всех» обязано быть не слабее одиночного «Остановить»: прогон в
   * окне отложенного авто-рестарта уже не числится в controllers, и раньше
   * кнопка проходила мимо него — таймер поднимал агента после остановки.
   */
  it('«Остановить всех» снимает и отложенный авто-рестарт', async () => {
    void agentRuns.start({ chatId: 'all-1', prompt: 'привет' });
    void agentRuns.start({ chatId: 'all-2', prompt: 'привет' });
    await settle();
    // Оба упали по временной причине — авто-рестарт запланирован, контроллеров нет.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    agentRuns.stopAll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenCalledWith('/chat/all-1/stop');
    expect(apiClient.post).toHaveBeenCalledWith('/chat/all-2/stop');
  });
  /**
   * Остановка в окне авто-рестарта: поток уже дочитан, контроллера нет. Без
   * финализации прогон навсегда оставался бы «идущим» — вечный крутящийся
   * индикатор до перезагрузки вкладки.
   */
  it('остановка в окне авто-рестарта завершает прогон, а не оставляет его «идущим»', async () => {
    void agentRuns.start({ chatId: 'fin-1', prompt: 'привет' });
    await settle();
    expect(getRun('fin-1').status).toBe('running');

    agentRuns.stop('fin-1');
    await settle();

    expect(getRun('fin-1').status).not.toBe('running');
  });
});
