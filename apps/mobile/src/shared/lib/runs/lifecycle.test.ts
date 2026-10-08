import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Стор прогонов телефона: подхват законченного, сторож потока, очередь.
 * Нативное подменено; сервер — вручную собранные SSE-потоки.
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
  apiUrl: (path: string, query?: Record<string, string | number>) =>
    `http://panel${path}${query ? `?${new URLSearchParams(query as Record<string, string>)}` : ''}`,
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
        other: (message: string) => message,
      },
    },
  }),
}));

import { restoreQueue, resumeActive, send, stop } from './lifecycle';
import type { ActiveRunInfo } from './types';
import { subscribe, runs, getRun, setRun, lastSeqs, controllers } from './store';

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

function active(info: Partial<ActiveRunInfo> & { chatId: string }): ActiveRunInfo {
  return { seq: 0, startedAt: 100, ...info };
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

describe('подхват из /chat/active', () => {
  it('законченный прогон заводится сразу законченным, текст в пузырь не набирается', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValueOnce([
      active({ chatId: 's1', sessionId: 's1', status: 'done', finishedAt: 150 }),
    ]);
    const seen = new Set<string>();
    const unsubscribe = subscribe(() => seen.add(getRun('s1').status));

    await resumeActive();
    stream.push({ kind: 'text', text: 'старый ответ', seq: 1 });
    stream.push({
      kind: 'usage',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 0.01,
      seq: 2,
    });
    stream.push({ kind: 'done', costUsd: 0.01, durationMs: 1, sessionId: 's1', seq: 3 });
    stream.close();
    await flush();
    unsubscribe();

    expect(seen.has('running')).toBe(false);
    const run = getRun('s1');
    expect(run.status).toBe('done');
    expect(run.text).toBe('');
    expect(run.tokens).toBe(15);
    expect(run.tailOnly).toBe(true);
  });

  it('догнанный прогон не подхватывается повторно; новый ход — подхватывается идущим', async () => {
    const first = sseStream();
    fetchMock.mockResolvedValueOnce(first.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', status: 'done' })]);
    await resumeActive();
    first.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's1', seq: 1 });
    first.close();
    await flush();

    apiGet.mockResolvedValueOnce([active({ chatId: 's1', status: 'done' })]);
    await resumeActive();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = sseStream();
    fetchMock.mockResolvedValueOnce(second.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1', startedAt: 200, status: 'running' })]);
    await resumeActive();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRun('s1').status).toBe('running');
    expect(getRun('s1').tailOnly).toBeUndefined();
  });

  it('разговор, известный под new-…, не заводится второй раз под sessionId', async () => {
    setRun('new-1', { status: 'done', sessionId: 's2', startedAt: 100 });
    apiGet.mockResolvedValueOnce([active({ chatId: 's2', sessionId: 's2', status: 'done' })]);
    await resumeActive();
    expect(runs.size).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('идущий прогон под чужим ключом стримится по серверному имени', async () => {
    setRun('new-1', { status: 'done', sessionId: 's3', startedAt: 50 });
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's3', sessionId: 's3', startedAt: 60 })]);
    await resumeActive();
    expect(runs.size).toBe(1);
    expect(getRun('new-1').status).toBe('running');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/chat/s3/stream');
  });
});

describe('сторож потока', () => {
  it('тишина дольше срока помечает прогон и переподключает с последнего seq', async () => {
    vi.useFakeTimers();
    const first = sseStream();
    const second = sseStream();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1' })]);
    await resumeActive();
    first.push({ kind: 'text', text: 'a', seq: 4 });
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').stalled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getRun('s1').stalled).toBe(true);
    expect(getRun('s1').status).toBe('running');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('from=4');

    second.push({ kind: 'text', text: 'b', seq: 5 });
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').stalled).toBeUndefined();
    expect(getRun('s1').text).toBe('ab');

    second.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's1', seq: 6 });
    second.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').status).toBe('done');
  });

  it('пинги держат поток живым', async () => {
    vi.useFakeTimers();
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1' })]);
    await resumeActive();
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      stream.ping();
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(getRun('s1').stalled).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('запрос без ответа рвётся по сроку и уходит на переподключение', async () => {
    vi.useFakeTimers();
    const stream = sseStream();
    fetchMock.mockImplementationOnce(hangingFetch).mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValueOnce([active({ chatId: 's1' })]);
    await resumeActive();
    await vi.advanceTimersByTimeAsync(30_000 + 1_500 + 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRun('s1').status).toBe('running');
  });

  it('исчерпанные переподключения — «связь потеряна», прогон можно подхватить заново', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch);
    apiGet.mockResolvedValue([active({ chatId: 's1' })]);
    await resumeActive();
    for (let i = 0; i < 22; i += 1) await vi.advanceTimersByTimeAsync(30_000 + 1_500 + 10);
    expect(getRun('s1').status).toBe('error');
    expect(getRun('s1').error).toBe('connection lost');
    expect(controllers.has('s1')).toBe(false);

    const calls = fetchMock.mock.calls.length;
    apiGet.mockResolvedValue([active({ chatId: 's1', startedAt: 200 })]);
    await resumeActive();
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    expect(getRun('s1').status).toBe('running');
  });
});

/**
 * Ревью 28.09 (F-145): сервер не снял процесс — номер нечем проверить, и чужое
 * он не трогает. Раньше телефон глотал любой отказ и рисовал «остановлено», а
 * агент работал дальше.
 */
describe('«Остановить», которое сервер не подтвердил (F-145)', () => {
  it('409 stop_unconfirmed: прогон идёт дальше, поток не оборван, человек видит почему', async () => {
    setRun('c9', { status: 'running' });
    const stream = new AbortController();
    controllers.set('c9', stream);
    apiPost.mockRejectedValueOnce(
      Object.assign(new Error('Процесс агента не остановлен'), {
        status: 409,
        code: 'stop_unconfirmed',
      }),
    );

    await stop('c9');

    expect(getRun('c9').status).toBe('running');
    expect(getRun('c9').error).toBe('Процесс агента не остановлен');
    expect(stream.signal.aborted).toBe(false);
  });

  it('прогона на сервере уже нет — по-прежнему «остановлено»', async () => {
    setRun('c10', { status: 'running' });
    apiPost.mockRejectedValueOnce(Object.assign(new Error('нет'), { status: 404 }));
    await stop('c10');
    expect(getRun('c10').status).toBe('stopped');
  });
});

describe('отказ «занят» в первые секунды хода (F-67)', () => {
  it('409 run_busy: прогон подхвачен, ответ встал в очередь и принят', async () => {
    // Inbox и /chat/active опрашиваются независимо: телефон ещё не знает о ходе,
    // начатом с компьютера, — подсказка «ответ уйдёт, когда он закончит ход»
    // должна выполняться и тут, а не показывать отказ.
    const stream = sseStream();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: 'run_busy', runId: 'srv-1' }),
      } as unknown as Response)
      .mockResolvedValueOnce(stream.response);

    const outcome = await send({ chatId: 'c1', prompt: 'Да, удаляй', allowEdits: true });
    await flush();

    expect(outcome).toEqual({ ok: true });
    const run = getRun('c1');
    expect(run.status).toBe('running');
    expect(run.queued.map((item) => item.prompt)).toEqual(['Да, удаляй']);
    expect(run.queued[0]?.allowEdits).toBe(true);
    // Поток идёт по серверному имени прогона из отказа.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/chat/srv-1/stream');
    controllers.get('c1')?.abort();
  });
});

describe('очередь дописанного', () => {
  it('сохраняется под id сессии и досылается после перезапуска, когда агент свободен', async () => {
    setRun('s1', { status: 'running', sessionId: 's1' });
    controllers.set('s1', new AbortController());
    await send({ chatId: 's1', prompt: 'потом скажи это' });
    await flush();
    expect(storage.has('agentdeck:chat-queue:s1')).toBe(true);

    // «Перезапуск»: память приложения пуста, хранилище — нет.
    runs.clear();
    controllers.clear();
    apiGet.mockResolvedValue([]);
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);

    await restoreQueue('s1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ chatId: 's1', prompt: 'потом скажи это' });
    expect(storage.has('agentdeck:chat-queue:s1')).toBe(false);
  });

  it('при живом прогоне восстановленная очередь ждёт конца хода', async () => {
    storage.set(
      'agentdeck:chat-queue:s1',
      JSON.stringify({ savedAt: Date.now(), items: [{ id: 'q-1', prompt: 'ещё' }] }),
    );
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValue([active({ chatId: 's1', sessionId: 's1' })]);

    await restoreQueue('s1');
    expect(getRun('s1').status).toBe('running');
    expect(getRun('s1').queued.map((item) => item.prompt)).toEqual(['ещё']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('очередь под ключом прежнего имени продукта подхватывается и переезжает', async () => {
    // Прежнее имя записано задом наперёд: литерала в дереве нет (историю
    // переписывают заменой слова), а ошибку в сборке ключа тест должен поймать.
    const legacyKey = `${[...'lortnoc-edualc'].reverse().join('')}:chat-queue:s1`;
    storage.set(
      legacyKey,
      JSON.stringify({ savedAt: Date.now(), items: [{ id: 'q-1', prompt: 'из старой версии' }] }),
    );
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    apiGet.mockResolvedValue([active({ chatId: 's1', sessionId: 's1' })]);

    await restoreQueue('s1');
    expect(getRun('s1').queued.map((item) => item.prompt)).toEqual(['из старой версии']);
    expect(storage.has(legacyKey)).toBe(false);
    expect(storage.has('agentdeck:chat-queue:s1')).toBe(true);
  });

  it('протухшая очередь не досылается и стирается', async () => {
    storage.set(
      'agentdeck:chat-queue:s1',
      JSON.stringify({
        savedAt: Date.now() - 3 * 60 * 60 * 1000,
        items: [{ id: 'q-1', prompt: 'вчерашнее' }],
      }),
    );
    apiGet.mockResolvedValue([]);
    await restoreQueue('s1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('снятое из очереди исчезает и из хранилища', async () => {
    setRun('s1', { status: 'running', sessionId: 's1' });
    controllers.set('s1', new AbortController());
    await send({ chatId: 's1', prompt: 'первое' });
    await flush();
    const { cancelQueued } = await import('./lifecycle');
    cancelQueued('s1', getRun('s1').queued[0]!.id);
    await flush();
    expect(getRun('s1').queued).toEqual([]);
    expect(storage.size).toBe(0);
  });
});

describe('чем ведут прогон', () => {
  it('модель берётся из события сессии, а не из того, что телефон отправил', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);

    // Телефон модель не назвал — так уходит и обычное сообщение (в поле ввода
    // стоит «как в настройках»), и любое сообщение в чат, заведённый
    // разделением: там модель подобрала панель.
    void send({ chatId: 'new-1', prompt: 'привет' });
    await flush();

    stream.push({ kind: 'session', sessionId: 's9', model: 'claude-sonnet-5', tools: 0, seq: 1 });
    await flush();

    expect(getRun('new-1').model).toBe('claude-sonnet-5');
  });
});
