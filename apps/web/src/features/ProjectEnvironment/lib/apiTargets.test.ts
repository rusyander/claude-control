import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ApiSpec } from '@entities/ApiExplorer';
import { apiErrorText } from './apiError';
import { baseSuggestions } from './apiTargets';

const spec = (servers: string[]): ApiSpec => ({
  sourceId: 'file:openapi.yaml',
  title: 'CP',
  format: '3.0',
  servers,
  endpoints: [],
  warnings: [],
});

describe('baseSuggestions', () => {
  const env = [
    { url: 'http://localhost:3000', file: 'e2e/.env', key: 'CP_URL' },
    { url: 'https://cp.dev.example.com', file: 'e2e/.env', key: 'DEV_CP_URL' },
    { url: 'https://chat.dev.example.com', file: 'e2e/.env', key: 'DEV_CHAT_URL' },
  ];

  it('стенд из .env с хостом как у контракта — выше заглушки контракта', () => {
    expect(baseSuggestions(spec(['https://cp.example.io']), [], env)).toEqual([
      { url: 'https://cp.dev.example.com', origin: 'env', note: 'e2e/.env · DEV_CP_URL' },
      { url: 'https://cp.example.io', origin: 'contract' },
      { url: 'http://localhost:3000', origin: 'env', note: 'e2e/.env · CP_URL' },
      { url: 'https://chat.dev.example.com', origin: 'env', note: 'e2e/.env · DEV_CHAT_URL' },
    ]);
  });

  it('запущенный сервис — первым, с относительным сервером контракта; повтор — один раз', () => {
    const list = baseSuggestions(
      spec(['/api', 'http://localhost:8080/']),
      [{ name: 'api', url: 'http://localhost:8080' }],
      [{ url: 'http://localhost:8080', file: '.env', key: 'API' }],
    );
    expect(list.map((item) => `${item.origin} ${item.url}`)).toEqual([
      'service http://localhost:8080/api',
      'service http://localhost:8080',
    ]);
  });
});

describe('apiErrorText — причина сетевого отказа', () => {
  const t = ((key: string, params?: Record<string, unknown>) =>
    `${key} ${JSON.stringify(params ?? {})}`) as unknown as TFunction;
  const refusal = (detail: string, message: string): AxiosError =>
    new AxiosError('fail', '502', undefined, undefined, {
      status: 502,
      statusText: 'Bad Gateway',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { code: 'api-send-failed', kind: 'connect', detail, message },
    });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'reset'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['EHOSTUNREACH', 'connect'],
  ])('%s → %s, с хостом', (code, kind) => {
    const text = apiErrorText(refusal(code, `${code} cp.example.io`), t);
    expect(text.startsWith(`environment.api.errors.send.${kind} `)).toBe(true);
    expect(text).toContain('"host":"cp.example.io"');
  });

  it('без кода — общий текст с сообщением', () => {
    expect(apiErrorText(refusal('', 'socket hang up'), t)).toContain(
      'environment.api.errors.send.connect',
    );
  });
});
