import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React не поднимается (окружение node): эффект выполняется сразу, как при рендере; ссылки живут
// между «рендерами» одного теста по порядку вызова, как у смонтированного компонента.
const invalidateQueries = vi.fn();
let refs: Array<{ current: unknown }> = [];
let refAt = 0;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => effect(),
  useRef: (initial: unknown) => (refs[refAt++] ??= { current: initial }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries }),
  // Отпечатка ленты ещё нет: перечитать её здесь может только граница хода, а не опрос.
  useQuery: () => ({ data: undefined }),
}));
const post = vi.fn();
vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: (...args: unknown[]) => post(...args),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

const autoRefresh = await import('./useChatAutoRefresh');
const { chatKeys } = await import('./ChatApi.constants');
const { agentRuns, getRun } = await import('@shared/lib/agent-runs');

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

/** «Рендер» ленты идущего прогона (связь есть) с границей хода `turnAt`. */
const renderAt = (chatId: string | undefined, turnAt: number | undefined): void => {
  refAt = 0;
  autoRefresh.useChatAutoRefresh(chatId, true, false, turnAt);
};
/** «Рендер» с границей хода прогона из настоящего стора. */
const render = (chatId: string, runId: string): void => renderAt(chatId, getRun(runId).turnAt);

const messagesInvalidated = (): unknown[] =>
  invalidateQueries.mock.calls
    .map(([filter]) => (filter as { queryKey: unknown }).queryKey)
    .filter((key) => JSON.stringify(key).includes('messages'));

/**
 * F-02: чат чужого CLI на ядре — слово «на ходу» начинает новый ход того же прогона (`nextTurn`).
 * Пузырь потока на границе очищается и рисует новый ход, ответ прошлого хода лента берёт из
 * истории. Но историю, пока прогон идёт, никто не перечитывал — прошлый ответ исчезал с экрана до
 * конца прогона. Граница хода перечитывает переписку, как конец хода на телефоне.
 */
describe('граница хода перечитывает переписку идущего прогона (F-02)', () => {
  let stream: ReturnType<typeof openStream>;

  beforeEach(() => {
    refs = [];
    invalidateQueries.mockClear();
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

  it('nextTurn в потоке — переписка разговора перечитана один раз; без новой границы — нет', async () => {
    void agentRuns.start({ chatId: 'nt-run', prompt: 'ход-41', projectPath: '/p' });
    stream.push(
      '{"kind":"session","sessionId":"sess-nt","model":"m","tools":0,"startedAt":1000,"seq":1}',
    );
    stream.push('{"kind":"text","text":"готов","seq":2}');
    await settle();
    render('conv-1', 'nt-run');
    expect(messagesInvalidated()).toEqual([]);

    post.mockResolvedValueOnce({ data: { steered: true } });
    expect(await agentRuns.steer('nt-run', { prompt: 'ход-42' })).toBe('steered');
    stream.push('{"kind":"steer","text":"ход-42","at":"2026-11-06T10:00:00.000Z","seq":3}');
    stream.push('{"kind":"nextTurn","prompt":"ход-42","at":5000,"seq":4}');
    await settle();
    render('conv-1', 'nt-run');
    expect(messagesInvalidated()).toEqual([chatKeys.messages('conv-1')]);

    // Новый ход идёт, граница та же — перечитывать нечего (поток рисует ход сам).
    stream.push('{"kind":"text","text":"гот","seq":5}');
    await settle();
    render('conv-1', 'nt-run');
    expect(messagesInvalidated()).toHaveLength(1);
    stream.close();
    await settle();
  });

  it('смена разговора с чужой границей — не повод перечитывать', () => {
    renderAt('conv-a', undefined);
    renderAt('conv-b', 7000);
    expect(messagesInvalidated()).toEqual([]);
    renderAt('conv-b', 9000);
    expect(messagesInvalidated()).toEqual([chatKeys.messages('conv-b')]);
  });

  it('у черновика (разговора ещё нет) граница ничего не перечитывает', () => {
    renderAt(undefined, undefined);
    renderAt(undefined, 5000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
