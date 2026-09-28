import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AxiosError,
  CanceledError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import { apiClient } from './client';
import { setWatchCaptureEnabled } from '@shared/lib/watch-capture';

/**
 * Перехватчик клиента API → наблюдатель. Подменён только адаптер axios (сеть):
 * сам клиент, его перехватчик, проверка статуса axios и отправка сигнала —
 * настоящие.
 */

const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

const answer =
  (status: number, data: unknown): AxiosAdapter =>
  async (config: InternalAxiosRequestConfig) => {
    // Так отвечает настоящий адаптер на статус вне 2xx: AxiosError с ответом внутри.
    const response = { data, status, statusText: String(status), headers: {}, config };
    throw new AxiosError(
      `Request failed with status code ${status}`,
      status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      response,
    );
  };

function sentBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => {
    const init = (call as unknown as [string, RequestInit])[1];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  });
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setWatchCaptureEnabled(true);
});
afterEach(() => {
  setWatchCaptureEnabled(false);
  vi.unstubAllGlobals();
});

describe('клиент API и фоновый наблюдатель', () => {
  it('ответ 5xx — отказ как раньше и сигнал с путём и статусом', async () => {
    const failed = apiClient.get('/qa-items/7', {
      adapter: answer(502, { message: 'upstream down' }),
    });
    await expect(failed).rejects.toMatchObject({ response: { status: 502 } });
    expect(sentBodies()).toEqual([
      expect.objectContaining({
        kind: 'api-failure',
        method: 'GET',
        path: '/api/qa-items/7',
        status: 502,
      }),
    ]);
  });

  it('5xx, уже записанный сервером (его заголовок), — сигнала со страницы нет', async () => {
    const seen: AxiosAdapter = async (config) => {
      const response = {
        data: { message: 'x' },
        status: 500,
        statusText: '500',
        headers: { 'x-agentdeck-watch': 'seen' },
        config,
      };
      throw new AxiosError('fail', AxiosError.ERR_BAD_RESPONSE, config, null, response);
    };
    await expect(apiClient.get('/qa-seen', { adapter: seen })).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 с HTML вместо JSON — ответ как был и сигнал «не того вида»', async () => {
    const html: AxiosAdapter = async (config) => ({
      data: '<!doctype html><html><body>Vite</body></html>',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
      config,
    });
    const reply = await apiClient.get('/qa-html', { adapter: html });
    expect(reply.status).toBe(200);
    const json: AxiosAdapter = async (config) => ({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      config,
    });
    await apiClient.get('/qa-json', { adapter: json });
    expect(sentBodies()).toEqual([
      expect.objectContaining({ kind: 'contract-mismatch', path: '/api/qa-html', status: 200 }),
    ]);
  });

  it('4xx и отменённый запрос — не сбой: сигнала нет', async () => {
    await expect(
      apiClient.get('/qa-missing', { adapter: answer(404, { message: 'nope' }) }),
    ).rejects.toBeTruthy();
    // Отмена уже в полёте: заранее отменённый запрос axios отклоняет ДО
    // перехватчиков, и такая проверка не ловила бы ничего.
    const controller = new AbortController();
    const inFlight: AxiosAdapter = (config) =>
      new Promise((_resolve, reject) => {
        (config.signal as AbortSignal).addEventListener('abort', () =>
          reject(new CanceledError(undefined, undefined, config)),
        );
      });
    const cancelled = apiClient.get('/qa-cancelled', {
      signal: controller.signal,
      adapter: inFlight,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: AxiosError.ERR_CANCELED });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
