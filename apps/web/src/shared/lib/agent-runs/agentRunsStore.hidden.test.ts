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
import { startActivePoll, HIDDEN_POLL_MS } from './agent-runs.poll';
import type { AgentRun } from './agent-runs.types';

/**
 * Скрытая вкладка (находка 77 живого прогона 24.09): человек сидит в другой
 * вкладке браузера, панель просто открыта. Раньше скрытая вкладка не держала ни
 * одного потока и не опрашивала сервер — прогон кончался, спрашивал или падал,
 * а панель молчала до возвращения. Теперь опрос `/chat/active` идёт и в скрытой
 * вкладке (реже), а законченному прогону дают ОДИН поток за хвостом — чтобы
 * узнать, чем кончился ход, и позвать человека.
 */

interface Held {
  url: string;
  signal?: AbortSignal;
}

const held: Held[] = [];

/** Поток: отдаёт кадры сервера и закрывается, если `close`; иначе живёт до отмены. */
function streamResponse(
  url: string,
  init: RequestInit | undefined,
  frames: string[],
  close: boolean,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      held.push({ url, signal: init?.signal ?? undefined });
      const encoder = new TextEncoder();
      for (const frame of frames) ctrl.enqueue(encoder.encode(`data: ${frame}\n\n`));
      if (close) ctrl.close();
      else
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

const streamsOpened = (): string[] =>
  held.filter((h) => h.url.includes('/stream')).map((h) => h.url);

type Active = { chatId: string; status: 'running' | 'done'; startedAt: number };

function activeAnswer(list: Active[]): void {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    url === '/chat/active'
      ? {
          data: list.map((info) => ({
            ...info,
            sessionId: info.chatId,
            projectPath: 'C:/work/proj',
            seq: 1,
          })),
        }
      : { data: [] },
  );
}

const hiddenDocument = (): { visibilityState: string; addEventListener: () => void } => {
  const doc = { visibilityState: 'hidden', addEventListener: () => undefined };
  vi.stubGlobal('document', doc);
  return doc;
};

describe('скрытая вкладка — хвост законченного прогона и зов человека', () => {
  afterEach(async () => {
    agentRuns.setOnBackgroundEvent(undefined);
    agentRuns.stopAll();
    for (const id of ['h1', 'h2', 'h3']) agentRuns.clear(id);
    await settle();
    held.length = 0;
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  it('прогон упал, пока вкладка скрыта: хвост дотянут одним потоком, человек позван', async () => {
    hiddenDocument();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        streamResponse(
          url,
          init,
          ['{"kind":"error","message":"упал","retriable":false,"seq":2}'],
          true,
        ),
      ),
    );
    const events: AgentRun[] = [];
    agentRuns.setOnBackgroundEvent((run) => events.push(run));

    activeAnswer([{ chatId: 'h1', status: 'running', startedAt: 1 }]);
    await agentRuns.resumeActive();
    await settle();
    // Идущий прогон в скрытой вкладке потока не держит.
    expect(streamsOpened()).toHaveLength(0);

    activeAnswer([{ chatId: 'h1', status: 'done', startedAt: 1 }]);
    await agentRuns.resumeActive();
    await settle();

    expect(streamsOpened()).toEqual(['/api/chat/h1/stream?from=0']);
    expect(getRun('h1').status).toBe('error');
    expect(events.map((run) => [run.id, run.status])).toEqual([['h1', 'error']]);
  });

  it('скрытая вкладка: поток — только хвосту, идущий остаётся без потока', async () => {
    hiddenDocument();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => streamResponse(url, init, [], false)),
    );

    activeAnswer([
      { chatId: 'h2', status: 'running', startedAt: 1 },
      { chatId: 'h3', status: 'running', startedAt: 2 },
    ]);
    await agentRuns.resumeActive();
    await settle();
    activeAnswer([
      { chatId: 'h2', status: 'running', startedAt: 1 },
      { chatId: 'h3', status: 'done', startedAt: 2 },
    ]);
    await agentRuns.resumeActive();
    await settle();

    expect(streamsOpened()).toHaveLength(1);
    expect(streamsOpened()[0]).toContain('/chat/h3/stream');
    expect(getRun('h2').parked).toBe(true);
  });

  it('вкладку скрыли — живые потоки отпущены, хвосту поток остаётся', async () => {
    const doc = { visibilityState: 'visible', addEventListener: () => undefined };
    vi.stubGlobal('document', doc);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => streamResponse(url, init, [], false)),
    );
    activeAnswer([
      { chatId: 'h2', status: 'running', startedAt: 1 },
      { chatId: 'h3', status: 'running', startedAt: 2 },
    ]);
    await agentRuns.resumeActive();
    await settle();
    expect(streamsOpened()).toHaveLength(2);

    doc.visibilityState = 'hidden';
    activeAnswer([
      { chatId: 'h2', status: 'running', startedAt: 1 },
      { chatId: 'h3', status: 'done', startedAt: 2 },
    ]);
    // Первый такт после скрытия отпускает живые потоки, второй дотягивает хвост.
    await agentRuns.resumeActive();
    await settle();
    expect(held.filter((h) => !h.signal?.aborted)).toHaveLength(0);
    await agentRuns.resumeActive();
    await settle();

    const alive = held.filter((h) => h.url.includes('/stream') && !h.signal?.aborted);
    expect(alive.map((h) => h.url)).toEqual([expect.stringContaining('/chat/h3/stream')]);
    expect(getRun('h2').parked).toBe(true);
    expect(getRun('h2').status).toBe('running');
  });
});

describe('опрос /chat/active — и в скрытой вкладке', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(apiClient.get).mockReset();
  });

  const polls = (): number =>
    vi.mocked(apiClient.get).mock.calls.filter((call) => call[0] === '/chat/active').length;

  it('скрытая вкладка спрашивает сервер реже, но спрашивает', async () => {
    vi.useFakeTimers();
    hiddenDocument();
    activeAnswer([]);

    const stop = startActivePoll();
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    // Первый вопрос сразу, дальше раз в HIDDEN_POLL_MS: 0, 15, 30, 45, 60 с.
    expect(polls()).toBe(1 + 60_000 / HIDDEN_POLL_MS);
    // Реже минуты сервер законченный прогон уже не называет (grace 60 с).
    expect(HIDDEN_POLL_MS).toBeLessThan(60_000);
  });

  it('видимая вкладка спрашивает каждые пять секунд', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined });
    activeAnswer([]);

    const stop = startActivePoll();
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    expect(polls()).toBe(1 + 6);
  });

  it('остановленный опрос больше не спрашивает', async () => {
    vi.useFakeTimers();
    hiddenDocument();
    activeAnswer([]);

    const stop = startActivePoll();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(polls()).toBe(1);
  });
});
