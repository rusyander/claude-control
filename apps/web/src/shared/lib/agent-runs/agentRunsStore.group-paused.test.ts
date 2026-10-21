import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const post = vi.fn();
vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: (...args: unknown[]) => post(...args),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Карточка 33 прогона 20.10: ответ человека на вопрос группы ушёл агенту на
 * ходу, а через полчаса, сразу после «Паузы» из хаба, — ещё раз новым запуском,
 * и группа на паузе пошла дальше. Досылка вкладки несёт метку слова и признак
 * `automatic`; отказ «группа на паузе» держит сообщение в очереди, пока человек
 * не решит сам.
 */

/** Поток SSE, который отдаёт кадры, когда тест скажет, и закрывается. */
function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    end(frame: string) {
      controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  };
}

const DONE = 'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"s-1","seq":1}';
const PAUSED = {
  code: 'group_paused',
  message: 'Группа на паузе — сообщение из очереди не отправлено, чтобы не будить её.',
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

const sendBodies = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/chat/send'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

describe('agentRuns — досылка очереди группе на паузе', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let first: ReturnType<typeof sseStream>;

  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    first = sseStream();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ответ на слово на ходу потерян — досылка несёт ту же метку и признак automatic', async () => {
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValue(
        new Response(JSON.stringify({ steered: true, duplicate: true }), { status: 202 }),
      );
    void agentRuns.start({ chatId: 'gp-1', prompt: 'работай' });
    await settle();
    // Сервер слово отдал, а ответ до вкладки не дошёл — срок ожидания вышел.
    post.mockRejectedValueOnce(new Error('timeout of 60000ms exceeded'));
    await agentRuns.steer('gp-1', { prompt: '«Сбой провайдера» (Рекомендую)' });

    const steerBody = post.mock.calls[0]?.[1] as { clientId?: string; steer?: boolean };
    expect(steerBody.steer).toBe(true);
    expect(getRun('gp-1').queued[0]?.clientId).toBe(steerBody.clientId);

    first.end(DONE);
    await settle();

    const resent = sendBodies(fetchMock).at(-1);
    expect(resent).toMatchObject({
      prompt: '«Сбой провайдера» (Рекомендую)',
      clientId: steerBody.clientId,
      automatic: true,
    });
  });

  it('409 group_paused: один запрос, сообщение ждёт в очереди; «Повторить» отправляет его от человека', async () => {
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(new Response(JSON.stringify(PAUSED), { status: 409 }));
    void agentRuns.start({ chatId: 'gp-2', prompt: 'работай' });
    await settle();
    agentRuns.enqueue('gp-2', { prompt: 'дописал, пока шло' });

    first.end(DONE);
    await settle();
    await settle();

    expect(sendBodies(fetchMock)).toHaveLength(2);
    expect(sendBodies(fetchMock)[1]).toMatchObject({
      prompt: 'дописал, пока шло',
      automatic: true,
    });
    expect(getRun('gp-2').queued.map((item) => item.prompt)).toEqual(['дописал, пока шло']);
    expect(getRun('gp-2').errorCode).toBe('group_paused');

    // Человек нажал «Повторить»: уходит то же сообщение, уже без `automatic`,
    // и из очереди оно уходит — второго раза по концу хода не будет.
    const human = sseStream();
    fetchMock.mockResolvedValueOnce(human.response);
    await agentRuns.retry('gp-2');
    await settle();

    const bodies = sendBodies(fetchMock);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ prompt: 'дописал, пока шло' });
    expect(bodies[2]?.automatic).toBeUndefined();
    expect(getRun('gp-2').queued).toEqual([]);
    agentRuns.stop('gp-2');
  });
});
