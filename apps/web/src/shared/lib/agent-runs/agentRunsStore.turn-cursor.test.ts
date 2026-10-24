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

/**
 * Курсор потока принадлежит ХОДУ. Новый ход под тем же ключом нумерует кадры с
 * нуля, а вкладка возвращалась к потоку с номером кадра прошлого хода: сервер
 * отдавал новый ход с этого номера — без начала, а то и пустым, и лента
 * молчала до перезагрузки. Теперь вкладка называет ход (`startedAt`), сервер,
 * видя другой ход, отдаёт его с начала, а пузырь начинается заново.
 *
 * Подменены только сеть (`fetch`, `/chat/active`) и видимость вкладки.
 */

interface Opened {
  url: string;
  signal?: AbortSignal;
}

const opened: Opened[] = [];

/** Поток из кадров сервера: закрывается, если `close`, иначе живёт до отмены. */
function streamResponse(
  url: string,
  init: RequestInit | undefined,
  frames: object[],
  close: boolean,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      opened.push({ url, signal: init?.signal ?? undefined });
      const encoder = new TextEncoder();
      for (const frame of frames)
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      if (close) ctrl.close();
      else
        init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason), {
          once: true,
        });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** Ответы сервера на запросы потока — по порядку. */
function scriptedFetch(script: { frames: object[]; close: boolean }[]): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      return streamResponse(url, init, step?.frames ?? [], step?.close ?? false);
    }),
  );
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

function activeAnswer(
  list: { chatId: string; status: 'running' | 'done'; startedAt: number }[],
): void {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    url === '/chat/active'
      ? { data: list.map((item) => ({ ...item, seq: 0, sessionId: item.chatId })) }
      : { data: [] },
  );
}

const session = (chatId: string, startedAt: number, seq: number): object => ({
  kind: 'session',
  sessionId: chatId,
  model: 'm',
  tools: 0,
  startedAt,
  seq,
});

describe('курсор прошлого хода — вкладка видит новый ход целиком', () => {
  afterEach(() => {
    agentRuns.setActiveId(undefined);
    opened.length = 0;
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('вкладку скрывали, пока шёл новый ход: возврат называет прошлый ход, новый — с чистого пузыря', async () => {
    const doc = { visibilityState: 'visible', addEventListener: () => undefined };
    vi.stubGlobal('document', doc);
    scriptedFetch([
      {
        frames: [session('tc1', 100, 1), { kind: 'text', text: 'старый', seq: 40 }],
        close: false,
      },
      {
        frames: [session('tc1', 200, 1), { kind: 'text', text: 'новый', seq: 2 }],
        close: false,
      },
    ]);
    activeAnswer([{ chatId: 'tc1', status: 'running', startedAt: 100 }]);
    await agentRuns.resumeActive();
    await settle();
    expect(getRun('tc1').text).toBe('старый');

    // Вкладку скрыли — живой поток отпущен, номер кадра остался.
    doc.visibilityState = 'hidden';
    await agentRuns.resumeActive();
    await settle();
    expect(getRun('tc1').parked).toBe(true);

    // Пока вкладка скрыта, прошлый ход кончился и начался новый.
    activeAnswer([{ chatId: 'tc1', status: 'running', startedAt: 200 }]);
    doc.visibilityState = 'visible';
    await agentRuns.resumeActive();
    await settle();

    const back = opened.at(-1)?.url ?? '';
    expect(opened).toHaveLength(2);
    expect(back).toContain('/chat/tc1/stream');
    expect(back).toContain('from=40');
    expect(back).toContain('startedAt=100');
    expect(getRun('tc1').text).toBe('новый');
    expect(getRun('tc1').startedAt).toBe(200);
    expect(getRun('tc1').status).toBe('running');
    agentRuns.stop('tc1');
  });

  it('связь оборвалась, пока шёл новый ход: переподключение называет ход, новый доходит до конца', async () => {
    scriptedFetch([
      {
        frames: [session('tc2', 100, 1), { kind: 'text', text: 'старый', seq: 40 }],
        close: true,
      },
      {
        frames: [
          session('tc2', 200, 1),
          { kind: 'text', text: 'новый', seq: 2 },
          { kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'tc2', seq: 3 },
        ],
        close: true,
      },
    ]);
    // Разговор открыт на экране: законченный ход держит пузырь, пока лента не перечитана.
    agentRuns.setActiveId('tc2');
    activeAnswer([{ chatId: 'tc2', status: 'running', startedAt: 100 }]);
    await agentRuns.resumeActive();
    await settle();
    // Первое переподключение — через секунду.
    await new Promise((done) => setTimeout(done, 1_100));
    await settle();

    const back = opened[1]?.url ?? '';
    expect(back).toContain('from=40');
    expect(back).toContain('startedAt=100');
    expect(getRun('tc2').text).toBe('новый');
    expect(getRun('tc2').startedAt).toBe(200);
    expect(getRun('tc2').costUsd).toBe(0);
    expect(getRun('tc2').status).not.toBe('running');
  });

  it('свой ход: курсор и startedAt того же хода — пузырь не сбрасывается', async () => {
    scriptedFetch([
      {
        frames: [session('tc3', 100, 1), { kind: 'text', text: 'нача', seq: 2 }],
        close: true,
      },
      {
        frames: [
          { kind: 'text', text: 'ло', seq: 3 },
          { kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'tc3', seq: 4 },
        ],
        close: true,
      },
    ]);
    agentRuns.setActiveId('tc3');
    activeAnswer([{ chatId: 'tc3', status: 'running', startedAt: 100 }]);
    await agentRuns.resumeActive();
    await settle();
    await new Promise((done) => setTimeout(done, 1_100));
    await settle();

    const back = opened[1]?.url ?? '';
    expect(back).toContain('from=2');
    expect(back).toContain('startedAt=100');
    expect(getRun('tc3').text).toBe('начало');
  });
});
