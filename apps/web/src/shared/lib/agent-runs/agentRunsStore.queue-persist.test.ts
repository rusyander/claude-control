import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    // `/chat/active` при подхвате: пусто — идущих прогонов на сервере нет.
    get: vi.fn(async () => ({ data: [] })),
  },
}));

/**
 * Очередь дописанного переживает перезагрузку страницы.
 *
 * Регрессия из аудита: очередь жила только в памяти вкладки. Дописал два
 * сообщения, пока агент работает, нажал F5 — их нет нигде: ни в ленте, ни в
 * транскрипте, ни в поле ввода. Своя же правка фронта (Vite перезагружает
 * страницу) стирала их так же. Здесь проверяется, что переживает, что не
 * воскресает и что не уходит дважды.
 *
 * «Перезагрузка» — это `vi.resetModules()` и повторный импорт стора: он
 * модуль-синглтон, и заново импортированный не помнит ничего, кроме того, что
 * лежит в хранилище. Само хранилище — глобальное, сбросу модулей не подвластно,
 * как и настоящий localStorage.
 */

const QUEUE_KEY = 'claude-control:chat-queue:';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
  };
}

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

/** Поток, который не закрывается: прогон остаётся живым, как настоящий. */
function openResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({ start() {} }),
  } as unknown as Response;
}

const DONE = 'data: {"kind":"done","costUsd":0,"durationMs":1,"sessionId":"s-1","seq":1}';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

/** Свежая вкладка: стор без памяти о прошлой жизни. */
async function reload(): Promise<typeof import('./agentRunsStore')> {
  vi.resetModules();
  return await import('./agentRunsStore');
}

describe('agentRuns — очередь переживает перезагрузку', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let storage: ReturnType<typeof fakeStorage>;

  const sentPrompts = (): string[] =>
    fetchMock.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ''));

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    fetchMock = vi.fn(async () => sseResponse([DONE]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('дописанное при живом агенте уходит после перезагрузки страницы', async () => {
    const before = await reload();
    // Ход идёт и не заканчивается — очередь дождалась бы его конца.
    fetchMock.mockImplementation(async () => openResponse());
    void before.agentRuns.start({ chatId: 'p-1', prompt: 'первое' });
    before.agentRuns.enqueue('p-1', { prompt: 'дописанное' });
    await settle();
    expect([...storage.map.keys()]).toEqual([`${QUEUE_KEY}p-1`]);

    // F5: стора нет, а на сервере прогон уже закончился (`/chat/active` пуст).
    const after = await reload();
    fetchMock.mockImplementation(async () => sseResponse([DONE]));
    await after.agentRuns.restoreQueue('p-1', 'p-1');
    await settle();

    expect(sentPrompts().some((body) => body.includes('дописанное'))).toBe(true);
    // Ушедшее из хранилища стёрто — второй перезагрузкой его не воскресить.
    expect([...storage.map.keys()]).toHaveLength(0);
  });

  it('снятое из очереди не воскресает после перезагрузки', async () => {
    const before = await reload();
    fetchMock.mockImplementation(async () => openResponse());
    void before.agentRuns.start({ chatId: 'p-2', prompt: 'первое' });
    const queuedId = before.agentRuns.enqueue('p-2', { prompt: 'ненужное' });
    before.agentRuns.cancelQueued('p-2', queuedId);
    await settle();

    const after = await reload();
    fetchMock.mockImplementation(async () => sseResponse([DONE]));
    await after.agentRuns.restoreQueue('p-2', 'p-2');
    await settle();

    expect(sentPrompts().some((body) => body.includes('ненужное'))).toBe(false);
  });

  it('очередь, ушедшая до перезагрузки, не отправляется вторым разом', async () => {
    const before = await reload();
    void before.agentRuns.start({ chatId: 'p-3', prompt: 'первое' });
    before.agentRuns.enqueue('p-3', { prompt: 'дописанное' });
    await settle();
    expect(before.getRun('p-3').queued).toHaveLength(0);

    const after = await reload();
    const sentBefore = sentPrompts().length;
    await after.agentRuns.restoreQueue('p-3', 'p-3');
    await settle();

    expect(sentPrompts()).toHaveLength(sentBefore);
  });

  /**
   * Очередь — это «скажи ему заодно вот что», а не письмо на завтра. Панель,
   * открытая через сутки, не должна сама поднимать агента ради реплики, про
   * которую человек давно забыл.
   */
  it('протухшая очередь не досылается и стирается', async () => {
    const stale = {
      savedAt: Date.now() - 5 * 60 * 60 * 1000,
      items: [{ id: 'q', prompt: 'вчерашнее' }],
    };
    storage.map.set(`${QUEUE_KEY}p-4`, JSON.stringify(stale));

    const store = await reload();
    await store.agentRuns.restoreQueue('p-4', 'p-4');
    await settle();

    expect(sentPrompts().some((body) => body.includes('вчерашнее'))).toBe(false);
    expect(storage.map.has(`${QUEUE_KEY}p-4`)).toBe(false);
  });

  /**
   * Новый разговор живёт под временным `new-…`, пока CLI не выдаст sessionId.
   * Сохранённая под ним очередь после перезагрузки недостижима: этого написания
   * больше не существует ни у кого — поэтому она переезжает на настоящий id.
   */
  it('очередь нового чата переезжает с временного id на выданный sessionId', async () => {
    // Поток, в который кадры вкладываются по ходу теста: сессия придёт ПОСЛЕ
    // того, как человек допишет сообщение, — так оно и бывает.
    let push: (frame: string) => void = () => undefined;
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              push = (frame) => controller.enqueue(encoder.encode(`${frame}\n\n`));
            },
          }),
        }) as unknown as Response,
    );

    const store = await reload();
    void store.agentRuns.start({ chatId: 'new-77', prompt: 'первое' });
    await settle();
    store.agentRuns.enqueue('new-77', { prompt: 'дописанное' });
    expect([...storage.map.keys()]).toEqual([`${QUEUE_KEY}new-77`]);

    push('data: {"kind":"session","sessionId":"s-77","seq":1}');
    await settle();

    expect([...storage.map.keys()]).toEqual([`${QUEUE_KEY}s-77`]);
  });
});
