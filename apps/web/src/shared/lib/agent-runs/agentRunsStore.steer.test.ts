import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const post = vi.fn();
vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: (...args: unknown[]) => post(...args),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Слово агенту посреди хода (решение владельца 30.09): как в самом Claude Code —
 * сообщение уходит в идущий ход сразу, агент учтёт его на ближайшем шаге, а не
 * после всей работы. Не вышло — очередь, как раньше: ничего не теряется.
 */

/** Поток SSE, который тест держит открытым и закрывает сам. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    push: (frame: string) => controller.enqueue(encoder.encode(`data: ${frame}\n\n`)),
    close: () => controller.close(),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns — слово агенту на ходу', () => {
  let stream: ReturnType<typeof openStream>;

  beforeEach(() => {
    post.mockReset();
    stream = openStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => stream.response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ход идёт — сообщение уходит агенту сразу, в очередь не встаёт', async () => {
    void agentRuns.start({ chatId: 'st-1', prompt: 'первое', projectPath: '/p' });
    stream.push('{"kind":"session","sessionId":"sess-1","model":"m","tools":0,"seq":1}');
    await settle();
    post.mockResolvedValueOnce({ data: { steered: true, runId: 'st-1' } });

    expect(await agentRuns.steer('st-1', { prompt: 'нашёл баг' })).toBe('steered');

    expect(post).toHaveBeenCalledWith(
      '/chat/send',
      expect.objectContaining({
        prompt: 'нашёл баг',
        steer: true,
        sessionId: 'sess-1',
        projectPath: '/p',
      }),
    );
    expect(getRun('st-1').queued).toEqual([]);
    stream.close();
  });

  // Ревью PR #1: ход кончился, пока шёл запрос «на ходу», — слово не должно
  // застрять в очереди уже закончившегося хода: досылается сразу, один раз.
  it('ход кончился во время запроса — слово досылается сразу, один раз', async () => {
    void agentRuns.start({ chatId: 'st-late', prompt: 'первое', projectPath: '/p' });
    stream.push('{"kind":"session","sessionId":"sess-l","model":"m","tools":0,"seq":1}');
    await settle();
    const fetchMock = vi.mocked(fetch);
    const started = fetchMock.mock.calls.length;
    const first = stream;
    post.mockImplementationOnce(async () => {
      first.push('{"kind":"done","costUsd":0,"durationMs":1,"sessionId":"sess-l","seq":2}');
      first.close();
      await settle();
      throw Object.assign(new Error('409'), { response: { status: 409 } });
    });
    stream = openStream();

    expect(await agentRuns.steer('st-late', { prompt: 'поздно' })).toBe('queued');
    await settle();

    expect(fetchMock.mock.calls.length - started).toBe(1);
    expect(getRun('st-late').queued).toEqual([]);
    stream.close();
  });

  it('событие steer кладёт реплику в ленту хода, конец хода её снимает', async () => {
    void agentRuns.start({ chatId: 'st-2', prompt: 'первое' });
    stream.push('{"kind":"steer","text":"добавь пункт","at":"2026-09-30T10:00:00.000Z","seq":1}');
    // Повтор того же кадра при переподключении — не дубль.
    stream.push('{"kind":"steer","text":"добавь пункт","at":"2026-09-30T10:00:00.000Z","seq":1}');
    await settle();
    expect(getRun('st-2').steered).toEqual([
      { text: 'добавь пункт', at: '2026-09-30T10:00:00.000Z' },
    ]);

    stream.push('{"kind":"done","costUsd":0,"durationMs":1,"sessionId":"s","seq":2}');
    stream.close();
    await settle();
    expect(getRun('st-2').steered).toBeUndefined();
  });

  it('сервер не принял на ходу — сообщение в очереди, ничего не потеряно', async () => {
    void agentRuns.start({ chatId: 'st-3', prompt: 'первое' });
    await settle();
    post.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 409 }));

    expect(await agentRuns.steer('st-3', { prompt: 'поздно' })).toBe('queued');
    expect(getRun('st-3').queued.map((item) => item.prompt)).toEqual(['поздно']);
    stream.close();
  });

  it('с вложением — сразу в очередь: картинка идёт своим ходом', async () => {
    void agentRuns.start({ chatId: 'st-4', prompt: 'первое' });
    await settle();

    const outcome = await agentRuns.steer('st-4', {
      prompt: 'смотри',
      files: [{ name: 'a.png', base64: 'x' }],
    });

    expect(outcome).toBe('queued');
    expect(post).not.toHaveBeenCalled();
    stream.close();
  });
});
