import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosError } from 'axios';

vi.mock('@shared/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/client')>();
  return {
    ...actual,
    apiClient: {
      defaults: { baseURL: '/api' },
      post: vi.fn(async () => ({ data: {} })),
      get: vi.fn(async () => ({ data: [] })),
    },
  };
});

import { apiClient } from '@shared/api/client';
import { agentRuns, getRun } from './agentRunsStore';

/**
 * Ревью 28.09 (F-145): сервер не снял процесс агента — номер нечем проверить, и
 * чужое он не трогает, — и ответил 409 `stop_unconfirmed`. Вкладка раньше уже
 * оборвала поток и закрыла ход как «остановленный»: агент работал дальше, а
 * лента молчала до перезагрузки, и ошибка читалась как «Request failed with
 * status code 409».
 */

/** Открытый поток, который живёт, пока запрос не отменят. */
function liveResponse(init?: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('data: {"kind":"text","text":"работаю","seq":1}\n\n'));
      init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason), {
        once: true,
      });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

function refusal(): AxiosError {
  return Object.assign(new Error('Request failed with status code 409'), {
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        code: 'stop_unconfirmed',
        messageCode: 'chat-stop-unconfirmed',
        message: 'Процесс агента не остановлен: панель не смогла проверить номер.',
      },
    },
  }) as unknown as AxiosError;
}

describe('«Остановить», которое сервер не подтвердил (F-145)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => liveResponse(init));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(apiClient.post).mockReset();
  });

  afterEach(() => {
    agentRuns.stop('su-1');
    vi.unstubAllGlobals();
  });

  it('прогон снова «идёт», поток подключён заново, ошибка — словами сервера', async () => {
    void agentRuns.start({ chatId: 'su-1', prompt: 'привет' });
    await settle();
    expect(getRun('su-1').status).toBe('running');

    vi.mocked(apiClient.post).mockRejectedValueOnce(refusal());
    agentRuns.stop('su-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settle();

    const run = getRun('su-1');
    expect(run.status).toBe('running');
    expect(run.error).not.toContain('status code');
    expect(run.error).toBeTruthy();
    // Подключение к тому же прогону, а не новая отправка.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/stream');
  });
});
