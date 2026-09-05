import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    // Хвост транскрипта для авто-повтора: пусто — значит реплика до истории не
    // дошла, и повтор отправит ту же задачу заново.
    get: vi.fn(async () => ({ data: { messages: [] } })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';
import { MAX_RECONNECT, STREAM_CONNECT_MS, STREAM_STALL_MS } from './agent-runs.constants';

/**
 * Замолчавший поток.
 *
 * Регрессия, ради которой написано: «задаю вопрос — висит бесконечно, а после
 * F5 агент уже всё ответил». Сокет умеет умирать молча — уснувшая машина,
 * моргнувшая сеть, перезапуск прокси, — и у `fetch` на этот случай нет ни
 * ошибки, ни срока. Читатель ждал вечно: прогон навсегда оставался «идущим», а
 * лента прятала из истории ходы этого прогона и показывала пустоту.
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

/** Открытый поток, который молчит: сокет есть, байтов нет и не будет. */
function silentResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  return { ok: true, status: 200, body } as unknown as Response;
}

/**
 * Запрос, который не отвечает вовсе. Своего срока у него нет — ровно как у
 * `fetch`, вставшего в очередь браузера; закончиться он может только отменой,
 * и тогда падает её причиной, как настоящий.
 */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('поток замолчал посреди прогона', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    agentRuns.setActiveId(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('тишина дольше срока → метка потери связи, переподключение, метка снята', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/chat/send')
        ? silentResponse()
        : sseResponse([
            'data: {"kind":"text","text":"дописал уже без тебя","seq":1}',
            'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"s-1"}',
          ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Открытый разговор: его текст стор при завершении не выбрасывает.
    agentRuns.setActiveId('stall-1');

    await agentRuns.start({ chatId: 'stall-1', prompt: 'привет' });
    await settle();
    expect(getRun('stall-1').status).toBe('running');
    expect(getRun('stall-1').stalled).toBeFalsy();

    // Пульс сервера идёт раз в 10 секунд: три пропущенных подряд — уже не
    // задумчивость. До срока ничего не решаем.
    await vi.advanceTimersByTimeAsync(STREAM_STALL_MS - 1000);
    await settle();
    expect(getRun('stall-1').stalled).toBeFalsy();

    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    // Связь потеряна — но прогон жив: он на сервере, и «Остановить» обязано
    // остаться на месте.
    expect(getRun('stall-1').stalled).toBe(true);
    expect(getRun('stall-1').status).toBe('running');

    // Переподключение догоняет пропущенное — и метку снимает.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    const attached = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/stream'));
    expect(attached).toContain('/chat/stall-1/stream');
    expect(getRun('stall-1').stalled).toBeFalsy();
    expect(getRun('stall-1').text).toContain('дописал уже без тебя');
  });

  /**
   * Тишина, которую не вылечили переподключения. Прогон при этом мог спокойно
   * доработать на сервере — просто вкладка его больше не слышит. Молчать здесь
   * нельзя: от «агент думает» это неотличимо, и человек ждёт ответа, которого
   * никто не пришлёт.
   */
  it('переподключения исчерпаны → метка обрыва, по которой лента говорит вслух', async () => {
    // Сокет открывается всегда и всегда молчит: каждое переподключение
    // упирается в ту же тишину, и бюджет попыток кончается.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => silentResponse()),
    );
    agentRuns.setActiveId('stall-3');

    await agentRuns.start({ chatId: 'stall-3', prompt: 'привет' });
    await settle();
    expect(getRun('stall-3').dropped).toBeFalsy();

    // Каждая попытка — срок тишины плюс отступ перед следующей.
    await vi.advanceTimersByTimeAsync((STREAM_STALL_MS + 5000) * (MAX_RECONNECT + 1));
    await settle();

    expect(getRun('stall-3').dropped).toBe(true);
    expect(getRun('stall-3').status).not.toBe('running');

    // Перечитал переписку — обещание «ответ ищите в истории» исполнено, и
    // строка о потерянной связи уходит вместе с ним.
    agentRuns.quiet('stall-3');
    expect(getRun('stall-3').dropped).toBeFalsy();
  });

  it('запрос потока не отвечает вовсе → срок на подключение, а не вечное ожидание', async () => {
    const fetchMock = vi.fn(hangingFetch);
    vi.stubGlobal('fetch', fetchMock);

    void agentRuns.start({ chatId: 'stall-2', prompt: 'привет' });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STREAM_CONNECT_MS + 500);
    await settle();
    // Запрос оборван по сроку — иначе он стоял бы в очереди браузера навсегда,
    // выглядя точно как работающий агент.
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);

    // Дальше сама себя перезапускает: обрыв связи — повод временный.
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    // Бюджет попыток кончился — человеку сказали правду, а не оставили крутиться.
    expect(getRun('stall-2').status).toBe('error');
    expect(getRun('stall-2').error).toBeTruthy();
    // Метка потери связи снята: «переподключаемся» и карточка ошибки разом —
    // два взаимоисключающих обещания.
    expect(getRun('stall-2').stalled).toBeFalsy();

    agentRuns.stop('stall-2');
  });
});
