import { describe, it, expect } from 'vitest';
import {
  defaultPlatformTransport,
  parseTransportHeaders,
  platformRequestUrl,
  platformTransportErrors,
  type PlatformTransport,
} from '@agentdeck/contracts/platform-transport';
import { contourHeaders } from './transport.ts';

/**
 * Сборка адреса и заголовков контура (DRV-04/05). Путь через саму пробу и шлюз
 * проверяют `probe.test.ts` и `gateway/upstream.test.ts`; здесь — края, которые
 * через них перебирать дорого.
 */

const transport = (patch: Partial<PlatformTransport> = {}): PlatformTransport => ({
  ...defaultPlatformTransport(),
  ...patch,
});

describe('platformRequestUrl', () => {
  it.each([
    ['https://api.example.ru', 'https://api.example.ru/v1/models'],
    ['https://api.example.ru///', 'https://api.example.ru/v1/models'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/models'],
    ['https://x.example/v1beta/', 'https://x.example/v1beta/models'],
    ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/models'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/models'],
    ['https://corp.openai.azure.com/openai/v1/', 'https://corp.openai.azure.com/openai/v1/models'],
  ])('auto: %s', (base, url) => {
    expect(platformRequestUrl(base, transport(), 'models')).toBe(url);
  });

  it('as-is: путь адреса не трогается', () => {
    expect(
      platformRequestUrl('https://gw.corp.example/llm', transport({ version: 'as-is' }), 'models'),
    ).toBe('https://gw.corp.example/llm/models');
  });

  it('параметры: адреса сохраняются, настройки ставятся поверх, пути добавляются', () => {
    expect(
      platformRequestUrl(
        'https://gw.corp.example/v1?api-version=old&tenant=a',
        transport({ query: '?api-version=2024-10-21' }),
        'agents/sessions/s%2F1?agent=lawyer',
      ),
    ).toBe(
      'https://gw.corp.example/v1/agents/sessions/s%2F1?api-version=2024-10-21&tenant=a&agent=lawyer',
    );
  });

  it('не http(s) — адреса нет, а не склейка', () => {
    expect(platformRequestUrl('ftp://x.example', transport(), 'models')).toBeUndefined();
    expect(platformRequestUrl('api.example.ru', transport(), 'models')).toBeUndefined();
  });
});

describe('заголовки и отказы настройки', () => {
  it('свой заголовок со схемой; лишние заголовки не перебивают accept и ключ', () => {
    const headers = contourHeaders(
      {
        baseUrl: '',
        driver: 'openai-compat',
        transport: transport({
          authHeader: 'X-Auth',
          authScheme: 'Token',
          headers: 'Accept: text/html\nX-Tenant: research\nx-auth: подмена',
        }),
      },
      'k-1',
    );
    expect(headers).toEqual({
      accept: 'application/json',
      'x-tenant': 'research',
      'x-auth': 'Token k-1',
    });
  });

  it('секрет в лишних заголовках и параметрах отвергается с именем, без значения', () => {
    const errors = platformTransportErrors(
      transport({
        headers: 'Authorization: Bearer sk-live\nX-Api-Key: sk-2\nsk-вставленный-ключ',
        query: 'api_key=sk-3&api-version=1&=sk-4',
      }),
    );
    expect(errors).toEqual([
      { field: 'headers', code: 'secret', subject: 'Authorization' },
      { field: 'headers', code: 'secret', subject: 'X-Api-Key' },
      { field: 'headers', code: 'line', subject: '3' },
      { field: 'query', code: 'secret', subject: 'api_key' },
      { field: 'query', code: 'line', subject: '3' },
    ]);
    expect(JSON.stringify(errors)).not.toContain('sk-');
  });

  it('заголовок ключа не токен или служебный — отказ', () => {
    expect(platformTransportErrors(transport({ authHeader: 'api key' }))).toEqual([
      { field: 'authHeader', code: 'token', subject: 'api key' },
    ]);
    expect(platformTransportErrors(transport({ authHeader: 'Content-Type' }))).toEqual([
      { field: 'authHeader', code: 'reserved', subject: 'Content-Type' },
    ]);
  });

  it('свой заголовок ключа запрещён и в лишних заголовках', () => {
    expect(parseTransportHeaders('Api-Key: x', 'authorization', 'api-key').errors).toEqual([
      { field: 'headers', code: 'secret', subject: 'Api-Key' },
    ]);
  });
});
