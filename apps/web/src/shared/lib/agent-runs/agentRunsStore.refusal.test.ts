import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getRun, shouldAutoRetry } from './agentRunsStore';

/**
 * Отказ сервера на отправку.
 *
 * Регрессии, ради которых написано:
 * 1) отказ приходил `error`-событием, а клиент решал по ТЕКСТУ, временный ли
 *    сбой, — вложение с именем `network.zip` или `report 503.pdf` давало две
 *    молчаливые переотправки заведомо отклонённого сообщения;
 * 2) отказ «прогон уже идёт» не оставлял человеку ничего: вкладка считала
 *    прогон завершённым, кнопки «Остановить» не было, спасала только F5.
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

/** Ответ-отказ: статус и структурное тело, потока нет. */
function refusalResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('решение об авто-перезапуске — только по структурному признаку', () => {
  const base = { error: 'сбой', lastPrompt: 'привет', spentRetries: 0, maxRetries: 2 };

  it('флаг сервера `retriable` — перезапускаем', () => {
    expect(shouldAutoRetry({ ...base, errorRetriable: true, stoppedByUser: false })).toBe(true);
  });

  it('текст с «network» и «503» без флага — НЕ перезапускаем', () => {
    // Ровно тот случай: имя отклонённого вложения попадало в текст ошибки.
    expect(
      shouldAutoRetry({
        ...base,
        error: 'Не поддерживаются вложения: network.zip, report 503.pdf',
        stoppedByUser: false,
      }),
    ).toBe(false);
  });

  it('отказ с кодом не перезапускаем даже с флагом временности', () => {
    expect(
      shouldAutoRetry({
        ...base,
        errorCode: 'unsupported_upload',
        errorRetriable: true,
        stoppedByUser: false,
      }),
    ).toBe(false);
  });

  it('бюджет исчерпан или остановлено человеком — не перезапускаем', () => {
    expect(
      shouldAutoRetry({ ...base, errorRetriable: true, spentRetries: 2, stoppedByUser: false }),
    ).toBe(false);
    expect(shouldAutoRetry({ ...base, errorRetriable: true, stoppedByUser: true })).toBe(false);
  });
});

describe('agentRuns.start — отказ сервера', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('отклонённое вложение: одна попытка, код отказа, никаких молчаливых ретраев', async () => {
    fetchMock = vi.fn(async () =>
      refusalResponse(415, {
        code: 'unsupported_upload',
        message: 'Не поддерживаются вложения: network.zip. Сообщение не отправлено.',
        files: ['network.zip'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await agentRuns.start({ chatId: 'ref-1', prompt: 'разбери' });
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(outcome).toEqual({
      ok: false,
      code: 'unsupported_upload',
      message: expect.stringContaining('network.zip') as unknown as string,
      files: ['network.zip'],
    });
    // Имя файла с «network» внутри больше не заказывает переотправку.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRun('ref-1').status).not.toBe('running');
  });

  it('«прогон уже идёт»: подключаемся к живому прогону — статус running и есть что останавливать', async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/chat/send')) {
        return refusalResponse(409, {
          code: 'run_busy',
          message: 'Предыдущий ответ ещё генерируется',
          // Прогон живёт под ключом другой вкладки.
          runId: 'new-777',
        });
      }
      // Поток чужого прогона: живой текст без терминального события.
      return sseResponse(['data: {"kind":"text","text":"уже отвечаю","seq":1}']);
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await agentRuns.start({ chatId: 'busy-1', prompt: 'второе' });
    await settle();

    // Отправку не приняли — вызывающий обязан сохранить текст человеку.
    expect(outcome).toMatchObject({ ok: false, code: 'run_busy' });

    // Но прогон подхвачен: виден его текст и он снова «идёт» → появится «Остановить».
    const stream = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('/stream'));
    expect(stream).toContain('/chat/new-777/stream');
    expect(getRun('busy-1').text).toContain('уже отвечаю');
    expect(getRun('busy-1').status).toBe('running');

    agentRuns.stop('busy-1');
  });
});
