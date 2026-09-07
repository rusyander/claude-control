import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntegrationError } from './errors.ts';
import { describeFailure, ensureOk, parseJson, requestJson, sendRequest } from './http.ts';

/**
 * Единственный выход панели наружу. Проверяем то, ради чего он один на пять
 * интеграций: один повтор и только на перегрузке, русская причина вместо кода и
 * ГЛАВНОЕ — секрет, спрятанный в адресе, не утекает в подробность отказа.
 *
 * Сеть здесь не трогается вовсе: `fetch` подменён.
 */

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

function stubFetch(responses: StubResponse[]): { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(String(url));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next?.throws) return Promise.reject(next.throws);
    const status = next?.status ?? 200;
    return Promise.resolve(
      new Response(next?.body ?? '', { status, headers: next?.headers ?? {} }),
    );
  });
  return { calls };
}

describe('domains/integrations/http', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('обычный ответ отдаётся как есть, без повторов', async () => {
    const { calls } = stubFetch([{ status: 404, body: 'nope' }]);
    const response = await sendRequest({ url: 'https://x/y', system: 'Jira' });
    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('429 повторяется РОВНО один раз и ждёт по Retry-After', async () => {
    const { calls } = stubFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: '{"ok":true}' },
    ]);
    const promise = sendRequest({ url: 'https://x/y', system: 'Jira' });
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await promise;
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('второй 503 уже не повторяется — иначе недоступный сервис молчит минуту', async () => {
    const { calls } = stubFetch([{ status: 503 }, { status: 503 }]);
    const promise = sendRequest({ url: 'https://x/y', system: 'Jira' });
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await promise;
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  it('ожидание по Retry-After обрезано потолком: сервис не задерживает панель надолго', async () => {
    const { calls } = stubFetch([
      { status: 429, headers: { 'retry-after': '600' } },
      { status: 200, body: '{}' },
    ]);
    const promise = sendRequest({ url: 'https://x/y', system: 'Jira' });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    expect(calls).toHaveLength(2);
  });

  it('не дозвонились — 502 с русской причиной', async () => {
    stubFetch([{ throws: new TypeError('fetch failed') }]);
    await expect(sendRequest({ url: 'https://x/y', system: 'Jira' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'integration_unreachable',
      message: expect.stringContaining('Нет связи с Jira'),
    });
  });

  it('вышло время — причина называет секунды, а не имя ошибки', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    stubFetch([{ throws: timeout }]);
    await expect(sendRequest({ url: 'https://x/y', system: 'Jira' })).rejects.toMatchObject({
      message: 'Jira не ответила за 15 с.',
    });
  });

  it('СЕКРЕТ В АДРЕСЕ не попадает в подробность отказа', async () => {
    stubFetch([{ throws: new TypeError('fetch failed') }]);
    const secret = '7654321:AAH-super-secret-value';
    let caught: unknown;
    try {
      await sendRequest({
        url: `https://api.telegram.org/bot${secret}/sendMessage`,
        label: 'https://api.telegram.org/bot<токен>/sendMessage',
        system: 'Telegram',
      });
    } catch (error) {
      caught = error;
    }
    const detail = (caught as IntegrationError).detail ?? '';
    expect(detail).not.toContain(secret);
    expect(detail).toContain('<токен>');
  });

  it('без label в подробности виден адрес — там секрета нет', async () => {
    stubFetch([{ throws: new TypeError('fetch failed') }]);
    await expect(sendRequest({ url: 'https://jira/x', system: 'Jira' })).rejects.toMatchObject({
      detail: 'https://jira/x',
    });
  });

  it('401 и 403 говорят одно и то же: токен отклонён', () => {
    for (const status of [401, 403]) {
      const text = describeFailure('Jira', {
        status,
        ok: false,
        text: '',
        headers: new Headers(),
      });
      expect(text).toContain('токен отклонён');
    }
  });

  it('остальные коды называются словами', () => {
    const base = { ok: false, text: '', headers: new Headers() };
    expect(describeFailure('Jira', { ...base, status: 404 })).toContain('адрес не найден');
    expect(describeFailure('Jira', { ...base, status: 429 })).toContain('слишком много запросов');
    expect(describeFailure('Jira', { ...base, status: 500 })).toContain('ошибкой 500');
    expect(describeFailure('Jira', { ...base, status: 418, text: 'чайник' })).toContain('чайник');
  });

  it('пустое тело — это null, а не падение разбора', () => {
    expect(parseJson('Jira', { status: 204, ok: true, text: '', headers: new Headers() })).toBe(
      null,
    );
  });

  it('не-JSON в ответе — понятный отказ, а не SyntaxError', () => {
    expect(() =>
      parseJson('Jira', { status: 200, ok: true, text: '<html>', headers: new Headers() }),
    ).toThrow(/ответила не JSON/);
  });

  it('ensureOk пропускает удачный ответ и отвергает отказ', () => {
    const ok = { status: 200, ok: true, text: '{}', headers: new Headers() };
    expect(ensureOk('Jira', ok)).toBe(ok);
    expect(() =>
      ensureOk('Jira', { status: 500, ok: false, text: 'boom', headers: new Headers() }),
    ).toThrow(IntegrationError);
  });

  it('requestJson = удачный запрос плюс разбор', async () => {
    stubFetch([{ status: 200, body: '{"key":"PRJ-1"}' }]);
    await expect(
      requestJson<{ key: string }>({ url: 'https://x', system: 'Jira' }),
    ).resolves.toEqual({ key: 'PRJ-1' });
  });

  it('двоичный ответ отдаёт байты, а текст оставляет только для отказа', async () => {
    stubFetch([{ status: 200, body: 'PK' }]);
    const response = await sendRequest({ url: 'https://x', system: 'CI', binary: true });
    expect(response.bytes?.length).toBeGreaterThan(0);
    expect(response.text).toBe('');
  });
});
