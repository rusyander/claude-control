import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Телефон и ход на сервере (жалоба владельца 23.10): сообщение с телефона
 * иногда не доходит до агента, а уже сделанное агентом телефон показывает только
 * после перезапуска приложения. Каждый тест — один путь, на котором это
 * случалось. Подменены только граница сети (`expo/fetch`, `api`), хранилище и
 * часы; стор, транспорт и очередь — настоящие.
 */

const storage = new Map<string, string>();
const fetchMock = vi.fn();
const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn() },
}));
vi.mock('expo/fetch', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));
vi.mock('../notifyLocally', () => ({
  notifyLocally: vi.fn(async () => undefined),
}));
vi.mock('../../api/connection', () => ({ isConfigured: () => true }));
vi.mock('../../api/client', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  apiUrl: (path: string, query?: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const tail = search.toString();
    return `http://panel${path}${tail ? `?${tail}` : ''}`;
  },
}));
vi.mock('../../api/authHeaders', () => ({
  authHeaders: () => ({}),
}));
vi.mock('../../config/i18n', () => ({
  dict: () => ({
    api: { tokenRejected: 'token rejected' },
    chat: { permissionLost: 'permission lost' },
    run: {
      serverUnreachable: 'unreachable',
      connectionLost: 'connection lost',
      reconnecting: 'reconnecting',
      finished: 'finished',
      failed: 'failed',
      homeChat: 'home',
      answered: (status: number) => `answered ${status}`,
      notSent: {
        busy: 'busy',
        files: () => 'files',
        workspaceMissing: () => 'workspace missing',
        other: (message: string) => `not sent: ${message}`,
      },
    },
  }),
}));

import { restoreQueue, resumeActive, send } from './lifecycle';
import type { ActiveRunInfo } from './types';
import { runs, getRun, lastSeqs, controllers } from './store';

/** Поток SSE, которым управляет тест: кадры уходят по вызову, конец — по `close`. */
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
    push(event: Record<string, unknown>) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    ping() {
      controller.enqueue(encoder.encode(': ping\n\n'));
    },
    close() {
      controller.close();
    },
  };
}

/** Запрос, который никогда не отвечает — только рвётся по сигналу. */
function hangingFetch(_url: string, init: { signal: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
/** Очередь пишет в хранилище в несколько шагов — ждём их на настоящих часах. */
const settleIo = (): Promise<void> => new Promise((done) => setTimeout(done, 20));

function active(info: Partial<ActiveRunInfo> & { chatId: string }): ActiveRunInfo {
  return { seq: 0, startedAt: 100, ...info };
}

const bodyOf = (call: number): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[call]?.[1] as { body: string }).body) as Record<string, unknown>;

/** Сеть на запросе `api`: до панели не дошли (как `ApiError(0, …)` клиента). */
const offline = (): Error => Object.assign(new Error('unreachable'), { status: 0 });

/** Довести поток до «связь потеряна»: каждая попытка висит до срока и рвётся. */
async function exhaust(): Promise<void> {
  for (let i = 0; i < 22; i += 1) await vi.advanceTimersByTimeAsync(30_000 + 1_500 + 10);
}

beforeEach(() => {
  runs.clear();
  lastSeqs.clear();
  controllers.clear();
  storage.clear();
  fetchMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('курсор прошлого хода (S2: ход виден только после перезапуска)', () => {
  it('поток оборвался в прошлом ходе: переподключение называет ход, новый — с чистого пузыря и до конца', async () => {
    vi.useFakeTimers();
    const first = sseStream();
    const second = sseStream();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', sessionId: 's1', startedAt: 100 })]);
    await resumeActive();
    first.push({ kind: 'session', sessionId: 's1', model: 'm', tools: 0, startedAt: 100, seq: 1 });
    first.push({ kind: 'text', text: 'старый ответ', seq: 40 });
    first.close();
    await vi.advanceTimersByTimeAsync(1_510);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = String(fetchMock.mock.calls[1]?.[0]);
    expect(url).toContain('from=40');
    expect(url).toContain('startedAt=100');

    // Сервер видит курсор чужого хода и отдаёт новый ход с начала.
    second.push({ kind: 'session', sessionId: 's1', model: 'm', tools: 0, startedAt: 200, seq: 1 });
    second.push({ kind: 'text', text: 'новый', seq: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').text).toBe('новый');
    expect(getRun('s1').startedAt).toBe(200);
    expect(getRun('s1').status).toBe('running');
    // Прошлый ход кончился, пока связи не было: его ответ — в транскрипте, экран перечитает.
    expect(getRun('s1').endedAt).toEqual(expect.any(Number));

    second.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's1', seq: 3 });
    second.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').status).toBe('done');
  });

  it('законченный ход, подхваченный опросом, оставляет отметку конца — по ней экран перечитывает ленту', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', sessionId: 's1', status: 'done' })]);
    await resumeActive();
    expect(getRun('s1').endedAt).toBeUndefined();

    stream.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's1', seq: 1 });
    stream.close();
    await flush();
    expect(getRun('s1').status).toBe('done');
    expect(getRun('s1').endedAt).toEqual(expect.any(Number));
  });
});

describe('связь потеряна — без перезапуска приложения', () => {
  it('тот же ход (тот же startedAt) подхватывается опросом заново', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch);
    apiGet.mockResolvedValue([active({ chatId: 's1', startedAt: 100 })]);
    await resumeActive();
    await exhaust();
    expect(getRun('s1').status).toBe('error');
    expect(getRun('s1').error).toBe('connection lost');

    const stream = sseStream();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(stream.response);
    await resumeActive();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/chat/s1/stream');
    expect(getRun('s1').status).toBe('running');
    expect(getRun('s1').error).toBeUndefined();
  });

  it('сервер прогон больше не называет: ход кончился — ошибка снята, очередь уходит', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch);
    apiGet.mockResolvedValue([active({ chatId: 's1', sessionId: 's1', startedAt: 100 })]);
    await resumeActive();
    apiPost.mockRejectedValueOnce(offline());
    await send({ chatId: 's1', prompt: 'потом' });
    expect(getRun('s1').queued.map((item) => item.prompt)).toEqual(['потом']);
    await exhaust();
    expect(getRun('s1').error).toBe('connection lost');

    const next = sseStream();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(next.response);
    apiGet.mockResolvedValue([]);
    await resumeActive();
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/chat/send');
    expect(bodyOf(0)).toMatchObject({ chatId: 's1', prompt: 'потом', sessionId: 's1' });
    expect(getRun('s1').queued).toEqual([]);
    expect(getRun('s1').status).toBe('running');
    expect(getRun('s1').error).toBeUndefined();
  });

  it('поток, который жил и оборвался, попытки не тратит; пустые обрывы — тратят', async () => {
    vi.useFakeTimers();
    // Живой поток: успел получить пульс — значит, связь была, ход длинный.
    fetchMock.mockImplementation(async () => {
      const stream = sseStream();
      stream.ping();
      stream.close();
      return stream.response;
    });
    apiGet.mockResolvedValueOnce([active({ chatId: 's1' })]);
    await resumeActive();
    for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(1_510);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(25);
    expect(getRun('s1').status).toBe('running');

    // Поток закрывается сразу и пустым — связи с ходом нет, потолок попыток работает.
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      const stream = sseStream();
      stream.close();
      return stream.response;
    });
    for (let i = 0; i < 25; i += 1) await vi.advanceTimersByTimeAsync(1_510);
    expect(getRun('s1').status).toBe('error');
    expect(getRun('s1').error).toBe('connection lost');
  });
});

describe('очередь не теряется (S1: сообщение не доходит)', () => {
  it('прогона на сервере уже нет (gone): разговор не забыт, очередь уходит', async () => {
    vi.useFakeTimers();
    const first = sseStream();
    const gone = sseStream();
    const next = sseStream();
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(gone.response)
      .mockResolvedValueOnce(next.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', sessionId: 's1' })]);
    await resumeActive();
    apiPost.mockRejectedValueOnce(offline());
    await send({ chatId: 's1', prompt: 'потом' });
    expect(getRun('s1').queued).toHaveLength(1);

    first.close();
    gone.push({ kind: 'gone' });
    gone.close();
    await vi.advanceTimersByTimeAsync(1_510);
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/chat/send');
    expect(bodyOf(2)).toMatchObject({ chatId: 's1', prompt: 'потом', sessionId: 's1' });
    expect(getRun('s1').sessionId).toBe('s1');
    expect(getRun('s1').queued).toEqual([]);
  });

  it('слово на ходу, а хода уже нет (409 run_steer_ended): уходит новым ходом, а не висит в очереди', async () => {
    const first = sseStream();
    const next = sseStream();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(next.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', sessionId: 's1' })]);
    await resumeActive();
    const [stale] = [...controllers.values()];
    apiPost.mockRejectedValueOnce(
      Object.assign(new Error('Ход уже закончился'), { status: 409, code: 'run_steer_ended' }),
    );

    const outcome = await send({ chatId: 's1', prompt: 'ещё вопрос' });
    await settleIo();

    expect(outcome).toEqual({ ok: true });
    expect(stale?.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/chat/send');
    expect(bodyOf(1)).toMatchObject({ chatId: 's1', prompt: 'ещё вопрос', sessionId: 's1' });
    expect(getRun('s1').queued).toEqual([]);
    expect(getRun('s1').status).toBe('running');
  });

  it('первая отправка не дошла: явный отказ, повтор того же текста — с той же меткой, опрос не заперт', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const outcome = await send({ chatId: 'c1', prompt: 'привет' });

    expect(outcome).toEqual({ ok: false, message: 'not sent: unreachable' });
    expect(getRun('c1').errorCode).toBe('unreachable');
    const firstId = bodyOf(0).clientId;
    expect(firstId).toEqual(expect.any(String));

    // Запрос мог дойти до сервера: опрос обязан суметь подхватить ход под этим ключом.
    const adopted = sseStream();
    fetchMock.mockResolvedValueOnce(adopted.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 'c1', startedAt: 300 })]);
    await resumeActive();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/chat/c1/stream');
    adopted.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'c1', seq: 1 });
    adopted.close();
    await flush();

    // Человек жмёт «Отправить» ещё раз: сервер, уже получивший первое, узнает повтор.
    const retry = sseStream();
    fetchMock.mockResolvedValueOnce(retry.response);
    await send({ chatId: 'c1', prompt: 'привет' });
    expect(bodyOf(2).clientId).toBe(firstId);
  });

  it('ошибка прошлой отправки не висит под новым ходом и не объявляет его упавшим', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await send({ chatId: 'c1', prompt: 'привет' });
    expect(getRun('c1').error).toBe('not sent: unreachable');

    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    await send({ chatId: 'c1', prompt: 'привет' });
    expect(getRun('c1').error).toBeUndefined();
    expect(getRun('c1').errorCode).toBeUndefined();
    stream.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'c1', seq: 1 });
    stream.close();
    await flush();
    expect(getRun('c1').status).toBe('done');
  });

  it('досылка из очереди не прошла по сети — уходит сама, когда панель снова отвечает', async () => {
    storage.set(
      'agentdeck:chat-queue:s1',
      JSON.stringify({
        savedAt: Date.now(),
        items: [{ id: 'q-1', prompt: 'ответ', clientId: 'queued-x' }],
      }),
    );
    apiGet.mockResolvedValue([]);
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await restoreQueue('s1');
    await settleIo();
    expect(getRun('s1').queued.map((item) => item.prompt)).toEqual(['ответ']);
    expect(getRun('s1').errorCode).toBe('unreachable');

    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    await resumeActive();
    await settleIo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toMatchObject({ prompt: 'ответ', clientId: 'queued-x', automatic: true });
    expect(getRun('s1').queued).toEqual([]);
  });

  it('группа на паузе: опрос досылку не повторяет — её снимает человек', async () => {
    storage.set(
      'agentdeck:chat-queue:s1',
      JSON.stringify({ savedAt: Date.now(), items: [{ id: 'q-1', prompt: 'ответ' }] }),
    );
    apiGet.mockResolvedValue([]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'group_paused', message: 'Группа на паузе' }),
    } as unknown as Response);
    await restoreQueue('s1');
    await settleIo();
    await resumeActive();
    await settleIo();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRun('s1').queued).toHaveLength(1);
  });

  it('у каждого сообщения в очереди своя метка: досылку уже принятого сервер узнает', async () => {
    const stream = sseStream();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: 'run_busy', runId: 'srv-1' }),
      } as unknown as Response)
      .mockResolvedValueOnce(stream.response);
    await send({ chatId: 'c1', prompt: 'Да' });
    await flush();
    expect(getRun('c1').queued[0]?.clientId).toEqual(expect.any(String));
    controllers.get('c1')?.abort();
  });
});

describe('чей поток пишет в прогон', () => {
  it('хвост законченного хода не закрывает новый, начатый с телефона', async () => {
    const tail = sseStream();
    const fresh = sseStream();
    fetchMock.mockResolvedValueOnce(tail.response).mockResolvedValueOnce(fresh.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', sessionId: 's1', status: 'done' })]);
    await resumeActive();
    expect(getRun('s1').status).toBe('done');

    void send({ chatId: 's1', prompt: 'новый вопрос', sessionId: 's1' });
    await flush();
    expect(getRun('s1').status).toBe('running');

    tail.push({
      kind: 'usage',
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      seq: 1,
    });
    tail.push({ kind: 'done', costUsd: 5, durationMs: 1, sessionId: 's1', seq: 2 });
    tail.close();
    await flush();
    expect(getRun('s1').status).toBe('running');
    expect(getRun('s1').tokens).toBe(0);
    expect(controllers.has('s1')).toBe(true);

    fresh.push({ kind: 'text', text: 'ответ', seq: 1 });
    await flush();
    expect(getRun('s1').text).toBe('ответ');
    controllers.get('s1')?.abort();
  });
});
