import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { apiClient } from '@shared/api/client';
import { MAX_STREAMS } from './agent-runs.constants';
import { agentRuns, getActiveRuns, getRun } from './agentRunsStore';

/**
 * Лимит потоков на вкладку (`agent-runs.slots`).
 *
 * Регрессия, ради которой написано: шесть идущих прогонов — шесть потоков плюс
 * лента событий, и браузер по HTTP/1.1 больше соединений к источнику не даёт.
 * Отправка в седьмой разговор вставала в очередь браузера молча и без срока —
 * «панель зависла». Теперь потоков не больше `MAX_STREAMS`, остальные прогоны
 * припаркованы и получают поток по приоритету, когда освободится место.
 */

interface Held {
  url: string;
  ctrl: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal;
  /** Закрыт «сервером» из теста, а не оборван вкладкой. */
  closed?: boolean;
}

/** Все открытые потоки — чтобы закрывать их с «серверной» стороны. */
const held: Held[] = [];

/** Поток, живущий до отмены запроса или до `close()` из теста. */
function liveResponse(url: string, init: RequestInit | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      held.push({ url, ctrl, signal: init?.signal ?? undefined });
      ctrl.enqueue(
        new TextEncoder().encode(
          'data: {"kind":"session","sessionId":"s","model":"m","tools":0}\n\n',
        ),
      );
      init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason), {
        once: true,
      });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

const streamsOpened = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/stream'));

/** Живые (не оборванные) потоки — то, что сейчас занимает соединения. */
const streamsAlive = (): string[] =>
  held
    .filter((h) => h.url.includes('/stream') && !h.signal?.aborted && !h.closed)
    .map((h) => h.url);

const running = (ids: string[]) =>
  ids.map((chatId, i) => ({
    chatId,
    sessionId: chatId,
    status: 'running' as const,
    startedAt: i + 1,
  }));

function activeAnswer(list: ReturnType<typeof running>): void {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    url === '/chat/active' ? { data: list } : { data: [] },
  );
}

describe('лимит потоков — не больше MAX_STREAMS на вкладку', () => {
  const six = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];

  afterEach(async () => {
    agentRuns.setActiveId(undefined);
    agentRuns.setWatched([]);
    agentRuns.stopAll();
    for (const id of [...six, 'r7', 'h1', 'h2']) agentRuns.clear(id);
    await settle();
    held.length = 0;
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('шесть идущих прогонов — три потока, остальные припаркованы по старшинству', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);

    activeAnswer(running(six));
    await agentRuns.resumeActive();
    await settle();

    expect(getActiveRuns()).toHaveLength(6);
    expect(streamsOpened(fetchMock)).toHaveLength(MAX_STREAMS);
    // Старшие — первые: r1..r3 с потоком, r4..r6 ждут.
    expect(six.map((id) => getRun(id).parked === true)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(getRun('r4').status).toBe('running');
  });

  it('поток закончился — место достаётся следующему припаркованному', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);
    activeAnswer(running(six));
    await agentRuns.resumeActive();
    await settle();

    // Прогон r1 кончился: сервер прислал `done` и закрыл поток.
    const r1 = held.find((h) => h.url.includes('/chat/r1/stream'));
    r1?.ctrl.enqueue(
      new TextEncoder().encode('data: {"kind":"done","costUsd":0,"sessionId":"r1","seq":2}\n\n'),
    );
    r1?.ctrl.close();
    if (r1) r1.closed = true;
    await settle();

    expect(getRun('r1').status).not.toBe('running');
    expect(streamsOpened(fetchMock)).toHaveLength(MAX_STREAMS + 1);
    expect(streamsOpened(fetchMock).at(-1)).toContain('/chat/r4/stream');
    expect(getRun('r4').parked).toBeUndefined();
    expect(streamsAlive()).toHaveLength(MAX_STREAMS);
  });

  it('открытый разговор забирает поток у младшего, не заканчивая его', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);
    activeAnswer(running(six));
    await agentRuns.resumeActive();
    await settle();

    agentRuns.setActiveId('r6');
    await settle();

    expect(getRun('r6').parked).toBeUndefined();
    expect(streamsOpened(fetchMock).at(-1)).toContain('/chat/r6/stream');
    // Отпущен младший из державших — r3; он всё ещё идёт, просто без потока.
    expect(getRun('r3').parked).toBe(true);
    expect(getRun('r3').status).toBe('running');
    expect(getActiveRuns()).toHaveLength(6);
    expect(streamsAlive()).toHaveLength(MAX_STREAMS);
  });

  it('отправка при полном бюджете уходит сразу, вытесняя младший поток', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);
    activeAnswer(running(six));
    await agentRuns.resumeActive();
    await settle();

    void agentRuns.start({ chatId: 'r7', prompt: 'седьмой' });
    await settle();

    const sends = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/chat/send'));
    expect(sends).toHaveLength(1);
    expect(getRun('r7').status).toBe('running');
    expect(getRun('r7').parked).toBeUndefined();
    // Держащих было трое; ради отправки один отпущен, и это младший.
    expect(getRun('r3').parked).toBe(true);
    expect(streamsAlive().length + sends.length).toBe(MAX_STREAMS);
  });

  it('припаркованный, которого сервер больше не называет, закрывается', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);
    activeAnswer(running(six));
    await agentRuns.resumeActive();
    await settle();
    expect(getRun('r6').parked).toBe(true);

    // r6 кончился и вышел из grace-буфера, пока стоял без потока.
    activeAnswer(running(six.slice(0, 5)));
    await agentRuns.resumeActive();
    await settle();

    expect(getRun('r6').status).not.toBe('running');
    expect(getRun('r6').parked).toBeUndefined();
    // Держащие потоки не тронуты: закрылся только тот, кого нет.
    expect(getRun('r1').status).toBe('running');
    expect(streamsAlive()).toHaveLength(MAX_STREAMS);
  });

  it('скрытая вкладка не держит ни одного потока, вернувшаяся — забирает', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => liveResponse(url, init));
    vi.stubGlobal('fetch', fetchMock);
    const doc = { visibilityState: 'hidden', addEventListener: () => undefined };
    vi.stubGlobal('document', doc);

    activeAnswer(running(['h1', 'h2']));
    await agentRuns.resumeActive();
    await settle();

    expect(streamsOpened(fetchMock)).toHaveLength(0);
    expect(getRun('h1').parked).toBe(true);
    expect(getRun('h1').status).toBe('running');

    doc.visibilityState = 'visible';
    agentRuns.setActiveId('h2');
    await settle();

    expect(streamsOpened(fetchMock)).toHaveLength(2);
    expect(getRun('h2').parked).toBeUndefined();
  });
});
