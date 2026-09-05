import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { apiClient } from '@shared/api/client';
import { agentRuns, getActiveRuns, getRun, subscribeRuns } from './agentRunsStore';

/**
 * Подхват идущих прогонов (`resumeActive`) и свежесть пульта.
 *
 * Регрессии, ради которых написано:
 * 1) один разговор подхватывался дважды — отсев шёл только по `info.chatId`,
 *    тогда как тот же разговор живёт в двух написаниях (временное `new-…` и
 *    настоящий `sessionId`). В пульте получались две строки на один разговор,
 *    две точки и два открытых потока к одному прогону;
 * 2) вопрос ребёнка доезжал до родителя с задержкой до двадцати секунд: снимок
 *    пульта пересобирался только на смене статуса и по сторожевому таймеру, а
 *    вопросы детей родитель читает именно из снимка.
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

/** Открытый поток, который живёт, пока запрос не отменят. */
function liveResponse(init: RequestInit | undefined, frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const encoder = new TextEncoder();
      for (const frame of frames) ctrl.enqueue(encoder.encode(`${frame}\n\n`));
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

/** Ответ `/chat/active` для этого прогона; всё остальное — обычные вызовы. */
function activeAnswer(
  list: { chatId: string; sessionId?: string; status?: 'running' | 'done'; startedAt?: number }[],
): void {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    url === '/chat/active' ? { data: list } : { data: [] },
  );
}

describe('resumeActive — один разговор подхватывается один раз', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('прогон знаком под `new-…`, а сервер называет его sessionId — второй записи нет', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      liveResponse(init, ['data: {"kind":"session","sessionId":"sess-1","model":"m","tools":0}']),
    );
    vi.stubGlobal('fetch', fetchMock);

    void agentRuns.start({ chatId: 'new-1', prompt: 'привет' });
    await settle();
    expect(getRun('new-1').sessionId).toBe('sess-1');

    activeAnswer([{ chatId: 'sess-1', sessionId: 'sess-1' }]);
    await agentRuns.resumeActive();
    await settle();

    // Ровно один прогон и ровно один поток: подхвата-двойника не случилось.
    expect(getActiveRuns()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    agentRuns.stop('new-1');
    agentRuns.clear('new-1');
  });

  it('обратная перестановка: знаем по sessionId, сервер зовёт временным ключом', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      liveResponse(init, ['data: {"kind":"session","sessionId":"sess-2","model":"m","tools":0}']),
    );
    vi.stubGlobal('fetch', fetchMock);

    void agentRuns.start({ chatId: 'sess-2', prompt: 'привет' });
    await settle();

    activeAnswer([{ chatId: 'new-2', sessionId: 'sess-2' }]);
    await agentRuns.resumeActive();
    await settle();

    expect(getActiveRuns()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    agentRuns.stop('sess-2');
    agentRuns.clear('sess-2');
  });
});

describe('свежесть пульта — снимок пересобирается на том, что в нём видно', () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('вопрос человеку виден в пульте сразу, а не через сторожевой таймер', async () => {
    const ask = JSON.stringify({ questions: [{ question: 'Какой вариант?', options: [] }] });
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: {"kind":"tool","name":"AskUserQuestion","input":${ask},"id":"t1","seq":1}`,
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    void agentRuns.start({ chatId: 'hub-1', prompt: 'спроси' });
    await settle();

    // Родительский разговор читает вопросы детей ровно отсюда.
    const shown = getActiveRuns().find((view) => view.id === 'hub-1');
    expect(shown?.tools?.some((tool) => tool.name === 'AskUserQuestion')).toBe(true);

    agentRuns.clear('hub-1');
  });

  it('расход обновляет цифры пульта сразу, а текст ответа снимок не трогает', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"kind":"usage","input":10,"output":5,"cacheRead":0,"cacheCreation":0,"seq":1}',
        'data: {"kind":"text","text":"и ещё много букв","seq":2}',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    void agentRuns.start({ chatId: 'hub-2', prompt: 'считай' });
    await settle();

    const shown = getActiveRuns().find((view) => view.id === 'hub-2');
    expect(shown?.tokens).toBe(15);
    // Текст в снимок не входит вовсе — пересобирать его на каждую букву значило
    // бы перерисовывать ленту табов на каждое слово ответа.
    expect(shown).not.toHaveProperty('text');

    agentRuns.clear('hub-2');
  });
});

/**
 * Подхват прогона, который УЖЕ закончился: сервер держит его в `/chat/active`
 * ещё минуту (grace), чтобы вкладка дотянула хвост — цену, расход, вопрос.
 * Регрессия: клиент заводил такой прогон идущим и с нулевого seq набирал его
 * текст заново — после F5 законченный разговор показывал «работает» и
 * «Остановить», а прочитанный ответ печатался с начала; после перечитки
 * истории запись убиралась, и следующий такт опроса повторял всё сначала.
 */
describe('resumeActive — законченный прогон из grace-буфера', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  const TAIL = [
    'data: {"kind":"text","text":"ответ целиком","seq":1}',
    'data: {"kind":"usage","input":10,"output":5,"cacheRead":0,"cacheCreation":0,"seq":2}',
    'data: {"kind":"done","costUsd":0.5,"sessionId":"fin-1","seq":3}',
  ];

  it('заводится сразу законченным, дотягивает хвост и не подхватывается повторно', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      fetchMock.mock.calls.length === 1
        ? sseResponse(TAIL)
        : liveResponse(init, [
            'data: {"kind":"session","sessionId":"fin-1","model":"m","tools":0}',
          ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Каждый снимок стора: «работает» не должно мелькнуть ни на один кадр.
    const seen = new Set<string>();
    const unsubscribe = subscribeRuns(() => seen.add(getRun('fin-1').status));

    activeAnswer([{ chatId: 'fin-1', sessionId: 'fin-1', status: 'done', startedAt: 1000 }]);
    await agentRuns.resumeActive();
    await settle();

    expect(seen.has('running')).toBe(false);
    const run = getRun('fin-1');
    expect(run.status).toBe('idle');
    // Хвост дотянут: цена и расход на месте, а текст — нет, он уже в истории.
    expect(run.costUsd).toBe(0.5);
    expect(run.tokens).toBe(15);
    expect(run.text).toBe('');

    // Перечитка истории убрала запись; сервер всё ещё называет прогон в grace.
    // Второго подхвата (и второго потока) быть не должно.
    agentRuns.clear('fin-1');
    await agentRuns.resumeActive();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRun('fin-1').status).toBe('idle');

    // А вот новый ход в том же разговоре — с другим стартом — подхватывается идущим.
    activeAnswer([{ chatId: 'fin-1', sessionId: 'fin-1', status: 'running', startedAt: 2000 }]);
    await agentRuns.resumeActive();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getRun('fin-1').status).toBe('running');

    unsubscribe();
    agentRuns.stop('fin-1');
    agentRuns.clear('fin-1');
  });
});
