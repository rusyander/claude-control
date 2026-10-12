import { describe, expect, it } from 'vitest';
import type { ApiEndpoint } from '@entities/ApiExplorer';
import {
  buildUrl,
  draftFromEndpoint,
  draftFromHistory,
  groupEndpoints,
  historyMatchesEndpoint,
  jsonProblem,
  missingPathParams,
  row,
} from './apiRequest';

const endpoint: ApiEndpoint = {
  id: 'POST /orders/{id}/items',
  method: 'post',
  path: '/orders/{id}/items',
  tags: ['orders'],
  params: [
    { name: 'id', in: 'path', required: true, example: 7 },
    { name: 'dry', in: 'query', required: false },
    { name: 'lang', in: 'query', required: false, example: 'ru' },
    { name: 'X-Trace', in: 'header', required: true },
  ],
  body: { contentType: 'application/json', required: true, example: { sku: 'A', qty: 1 } },
  responses: [],
};

describe('черновик по эндпоинту', () => {
  it('примеры в полях, необязательный без примера выключен, Content-Type из тела', () => {
    const draft = draftFromEndpoint(endpoint);
    expect(draft.pathValues).toEqual({ id: '7' });
    expect(draft.query.map(({ name, value, enabled }) => [name, value, enabled])).toEqual([
      ['dry', '', false],
      ['lang', 'ru', true],
    ]);
    expect(draft.headers.map(({ name, value }) => [name, value])).toEqual([
      ['X-Trace', ''],
      ['Content-Type', 'application/json'],
    ]);
    expect(JSON.parse(draft.body)).toEqual({ sku: 'A', qty: 1 });
  });

  it('запрос из Postman: заголовки и тело коллекции, без второго Content-Type', () => {
    const draft = draftFromEndpoint({
      ...endpoint,
      params: [],
      preset: { headers: [['content-type', 'text/plain']], body: 'raw' },
    });
    expect(draft.headers.map(({ name }) => name)).toEqual(['content-type']);
    expect(draft.body).toBe('raw');
  });
});

describe('адрес запроса', () => {
  it('база без хвостового слэша, параметр пути закодирован, выключенные параметры не уходят', () => {
    const draft = draftFromEndpoint(endpoint);
    draft.pathValues.id = 'a b/c';
    expect(buildUrl('http://localhost:8080/api/', draft)).toBe(
      'http://localhost:8080/api/orders/a%20b%2Fc/items?lang=ru',
    );
  });

  it('незаполненный параметр пути остаётся видимым и назван', () => {
    const draft = draftFromEndpoint(endpoint);
    draft.pathValues.id = ' ';
    expect(missingPathParams(draft)).toEqual(['id']);
    expect(buildUrl('http://h', draft)).toContain('/orders/{id}/items');
  });

  it('полный адрес из истории — база не приклеивается, свои параметры дописываются через &', () => {
    const draft = draftFromHistory({
      id: '1',
      at: '2026-10-12T10:00:00Z',
      method: 'get',
      url: 'https://stage.example.com/x?a=1',
      headers: [
        ['Authorization', 'Bearer ••••1234'],
        ['Accept', 'application/json'],
      ],
    });
    draft.query = [row('b', '2')];
    expect(buildUrl('http://localhost', draft)).toBe('https://stage.example.com/x?a=1&b=2');
    // Маска секрета повторно не уходит.
    expect(draft.headers.map(({ name }) => name)).toEqual(['Accept']);
  });
});

describe('повтор из истории по эндпоинту', () => {
  const entry = {
    id: '2',
    at: '2026-10-12T10:00:00Z',
    method: 'post' as const,
    url: 'https://stage.example.com/api/orders/a%20b/items?lang=en',
    headers: [] as [string, string][],
  };

  it('поля пути и параметры запроса снова заполнены, сервер остаётся тем же', () => {
    expect(historyMatchesEndpoint(entry, endpoint)).toBe(true);
    const draft = draftFromHistory(entry, endpoint);
    expect(draft.pathValues).toEqual({ id: 'a b' });
    expect(draft.query.map(({ name, value }) => [name, value])).toEqual([['lang', 'en']]);
    expect(missingPathParams(draft)).toEqual([]);
    draft.pathValues.id = '9';
    expect(buildUrl('http://localhost', draft)).toBe(
      'https://stage.example.com/api/orders/9/items?lang=en',
    );
  });

  it('другой путь или метод — не этот эндпоинт', () => {
    expect(historyMatchesEndpoint({ ...entry, url: 'https://h/orders/1' }, endpoint)).toBe(false);
    expect(historyMatchesEndpoint({ ...entry, method: 'get' }, endpoint)).toBe(false);
  });
});

describe('тело и список', () => {
  it('не JSON при JSON-типе — названо; при другом типе — молчим', () => {
    expect(jsonProblem('{"a":', 'application/json')).toBeTruthy();
    expect(jsonProblem('{"a":1}', 'application/json')).toBeUndefined();
    expect(jsonProblem('{"a":', 'text/plain')).toBeUndefined();
  });

  it('поиск по словам в методе, пути и описании; группы по тегу', () => {
    const list: ApiEndpoint[] = [
      endpoint,
      {
        ...endpoint,
        id: 'GET /health',
        method: 'get',
        path: '/health',
        tags: [],
        summary: 'Liveness',
      },
    ];
    expect(groupEndpoints(list, '').map((group) => group.tag)).toEqual(['orders', '']);
    expect(
      groupEndpoints(list, 'get live').flatMap((group) => group.endpoints.map((e) => e.id)),
    ).toEqual(['GET /health']);
    expect(groupEndpoints(list, 'delete')).toEqual([]);
  });
});
