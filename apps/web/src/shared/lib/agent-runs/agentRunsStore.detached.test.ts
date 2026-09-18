import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

import { apiClient } from '@shared/api/client';
import { agentRuns, getRun } from './agentRunsStore';
import { isStreamShown } from '@shared/lib/chat-stream';

/**
 * Прогон, усыновлённый сервером после его перезапуска: процесс агента жив,
 * трубы к нему нет. Вкладка узнаёт об этом двумя путями — меткой в
 * `/chat/active` (до первого события) и заметкой в потоке — и в обоих гасит
 * пузырь: текста не будет, а пузырь прятал бы из истории единственный ответ.
 */

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

describe('усыновлённый прогон — без пузыря, с картой прав', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('метка detached из /chat/active гасит пузырь ещё до первого события потока', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => liveResponse(init, [])),
    );
    vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
      url === '/chat/active'
        ? { data: [{ chatId: 'new-9', sessionId: 'sess-9', seq: 2, detached: true }] }
        : { data: [] },
    );

    await agentRuns.resumeActive();
    await settle();

    const run = getRun('new-9');
    expect(run.status).toBe('running');
    expect(run.detached).toBe(true);
    expect(isStreamShown({ isRunning: true, text: run.text, detached: run.detached })).toBe(false);

    agentRuns.stop('new-9');
    agentRuns.clear('new-9');
  });

  it('заметка потока `adopted` ставит метку и запасной текст; карточка прав приходит как обычно', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        liveResponse(init, [
          'data: {"kind":"session","sessionId":"sess-8","model":"m","tools":0}',
          'data: {"kind":"notice","code":"adopted","text":"подхвачен без потока"}',
          'data: {"kind":"permission","toolName":"Bash","input":{"command":"cp a b"},"toolUseId":"toolu_8"}',
        ]),
      ),
    );

    void agentRuns.start({ chatId: 'new-8', prompt: 'привет' });
    await settle();

    const run = getRun('new-8');
    expect(run.detached).toBe(true);
    expect(run.notice).toBe('подхвачен без потока');
    expect(run.permissions.map((item) => item.toolUseId)).toEqual(['toolu_8']);

    agentRuns.stop('new-8');
    agentRuns.clear('new-8');
  });

  it('заметка о конце текст обновляет, а метку подхвата не ставит', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        liveResponse(init, [
          'data: {"kind":"notice","code":"detachedDone","text":"процесс закрылся"}',
        ]),
      ),
    );

    void agentRuns.start({ chatId: 'new-7', prompt: 'привет' });
    await settle();

    const run = getRun('new-7');
    expect(run.detached).toBeUndefined();
    expect(run.notice).toBe('процесс закрылся');

    agentRuns.stop('new-7');
    agentRuns.clear('new-7');
  });

  it('заметка конвейера уровней переживает конец хода — это итог, а не строка про подхват', async () => {
    // Поток, который сервер ЗАКРЫЛ после `done`: только так прогон доходит до
    // `finalize`, а именно там строка про подхват и стирается.
    const closed = (frames: string[]): Response => {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const encoder = new TextEncoder();
          for (const frame of frames) ctrl.enqueue(encoder.encode(`${frame}\n\n`));
          ctrl.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        closed([
          'data: {"kind":"notice","code":"triageApplied","text":"Разбор применён: стартуют сразу: 2."}',
          'data: {"kind":"done"}',
        ]),
      ),
    );

    void agentRuns.start({ chatId: 'new-6', prompt: 'разбор' });
    await settle();

    const run = getRun('new-6');
    expect(run.status).not.toBe('running');
    expect(run.notice).toBe('Разбор применён: стартуют сразу: 2.');

    agentRuns.clear('new-6');
  });

  it('код заметки доезжает и переживает конец хода — без него лента вернулась бы к русской строке', async () => {
    const closed = (frames: string[]): Response => {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const encoder = new TextEncoder();
          for (const frame of frames)
            ctrl.enqueue(
              encoder.encode(`${frame}

`),
            );
          ctrl.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        closed([
          'data: {"kind":"notice","code":"triageMissing","text":"Разбор оборвался перезапуском панели.","textCode":"split-triage-interrupted-notice","textParams":{"groups":3}}',
          'data: {"kind":"done"}',
        ]),
      ),
    );

    void agentRuns.start({ chatId: 'new-8', prompt: 'разбор' });
    await settle();

    // Код живёт ровно там же, где строка: `finalize` оставляет итог хода в
    // ленте, и уехать он должен вместе с ней, а не раньше.
    const run = getRun('new-8');
    expect(run.noticeCode).toBe('split-triage-interrupted-notice');
    expect(run.noticeParams).toEqual({ groups: 3 });

    agentRuns.clear('new-8');
  });
});
