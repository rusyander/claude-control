import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiExplorerInfo, ProjectRunnerView } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { forgetProbeCache } from '../../domains/api-explorer/discover.ts';
import { forgetSpecCache } from '../../domains/api-explorer/load.ts';
import { registerApiExplorerRoutes } from './api-explorer-routes.ts';

/**
 * Маршруты вкладки «API» по HTTP целиком: граница «свой проект», источники
 * (файл, найденный у работающего сервиса, добавленный адрес, Postman),
 * отправка через настоящий локальный сервис со сверкой и история.
 */

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Orders' },
  paths: {
    '/orders/{id}': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['total'],
                  properties: { total: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

let service: Server;
let serviceUrl: string;
let lastAuth: string | undefined;

beforeAll(async () => {
  service = createServer((request, response) => {
    lastAuth = request.headers.authorization;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/openapi.json') response.end(JSON.stringify(SPEC));
    else if (request.url === '/orders/1') response.end('{"total":"12"}');
    else {
      response.statusCode = 404;
      response.end('{"error":"none"}');
    }
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterAll(async () => {
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
});

describe('api-explorer: маршруты', () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let stranger: string;
  let appData: string;
  let runs: ProjectRunnerView[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-api-routes-')));
    project = join(root, 'shop');
    stranger = join(root, 'other');
    appData = join(root, 'agentdeck');
    for (const dir of [project, stranger, appData]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(project, 'openapi.json'), JSON.stringify(SPEC));
    const store = new AppStore(appData);
    store.addProject({ id: 'shop', name: 'shop', path: project });
    runs = [];
    forgetProbeCache();
    forgetSpecCache();
    app = Fastify();
    registerApiExplorerRoutes(
      app,
      { store, location: { paths: { appData } } } as unknown as ServerContext,
      { runs: () => runs },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const info = async (path = project) =>
    (
      await app.inject({ method: 'GET', url: `/api/api-explorer?path=${encodeURIComponent(path)}` })
    ).json<ApiExplorerInfo>();
  const post = (url: string, payload: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST') =>
    app.inject({ method, url, payload });

  it('без пути — 400, чужой каталог — 403 и запрос не уходит', async () => {
    const bare = await app.inject({ method: 'GET', url: '/api/api-explorer' });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ code: 'api-path-required' });
    lastAuth = 'untouched';
    const refused = await post('/api/api-explorer/send', {
      path: stranger,
      method: 'get',
      url: `${serviceUrl}/orders/1`,
      headers: [['Authorization', 'x']],
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'api-project-unregistered' });
    expect(lastAuth).toBe('untouched');
  });

  it('файл проекта и контракт работающего сервиса — источники; разбор по sourceId', async () => {
    runs = [
      {
        projectPath: project,
        name: 'api',
        status: 'running',
        url: serviceUrl,
      } as ProjectRunnerView,
    ];
    const found = await info();
    expect(found.services).toEqual([{ name: 'api', url: serviceUrl }]);
    expect(found.sources.map((source) => source.id)).toEqual([
      'file:openapi.json',
      `url:${serviceUrl}/openapi.json`,
    ]);
    const spec = await app.inject({
      method: 'GET',
      url: `/api/api-explorer/spec?path=${encodeURIComponent(project)}&sourceId=file:openapi.json`,
    });
    expect(spec.json()).toMatchObject({ title: 'Orders', endpoints: [{ id: 'GET /orders/{id}' }] });
    const outside = await app.inject({
      method: 'GET',
      url: `/api/api-explorer/spec?path=${encodeURIComponent(project)}&sourceId=file:../other/x.json`,
    });
    expect(outside.statusCode).toBe(404);
  });

  it('адрес без контракта не добавляется; с контрактом — добавлен и убирается', async () => {
    const bad = await post('/api/api-explorer/sources', {
      path: project,
      url: `${serviceUrl}/nope`,
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toMatchObject({ code: 'api-spec-failed', kind: 'fetch' });
    const good = await post('/api/api-explorer/sources', {
      path: project,
      url: `${serviceUrl}/openapi.json`,
    });
    expect(good.json()).toMatchObject({ sourceId: `url:${serviceUrl}/openapi.json` });
    expect((await info()).sources).toContainEqual(
      expect.objectContaining({ id: `url:${serviceUrl}/openapi.json`, removable: true }),
    );
    const fileRemove = await post('/api/api-explorer/sources/remove', {
      path: project,
      sourceId: 'file:openapi.json',
    });
    expect(fileRemove.json()).toMatchObject({ code: 'api-source-not-removable' });
    await post('/api/api-explorer/sources/remove', {
      path: project,
      sourceId: `url:${serviceUrl}/openapi.json`,
    });
    expect((await info()).sources.map((source) => source.id)).toEqual(['file:openapi.json']);
  });

  it('Postman принят, OpenAPI под видом Postman — отказ', async () => {
    const notPostman = await post('/api/api-explorer/postman', {
      path: project,
      content: JSON.stringify(SPEC),
    });
    expect(notPostman.json()).toMatchObject({ code: 'api-not-postman' });
    const collection = JSON.stringify({
      info: { _postman_id: '1', name: 'Calls' },
      item: [{ name: 'One', request: { method: 'GET', url: `${serviceUrl}/orders/1` } }],
    });
    const added = await post('/api/api-explorer/postman', { path: project, content: collection });
    const sourceId = added.json<{ sourceId: string }>().sourceId;
    expect(sourceId).toMatch(/^postman:/);
    expect((await info()).sources).toContainEqual(
      expect.objectContaining({ id: sourceId, kind: 'postman', label: 'Calls' }),
    );
  });

  it('отправка со сверкой и сохранённой авторизацией; значение ключа наружу не уходит', async () => {
    const saved = await post(
      '/api/api-explorer/settings',
      {
        path: project,
        baseUrl: `${serviceUrl}/`,
        auth: { header: 'Authorization', value: 'Bearer top-secret-value-0000' },
      },
      'PUT',
    );
    expect(saved.json()).toMatchObject({
      baseUrl: serviceUrl,
      auth: { header: 'Authorization', masked: 'Bearer ••••0000' },
    });
    expect(saved.body).not.toContain('top-secret');
    const sent = await post('/api/api-explorer/send', {
      path: project,
      method: 'get',
      url: `${serviceUrl}/orders/1`,
      headers: [],
      sourceId: 'file:openapi.json',
      endpointId: 'GET /orders/{id}',
      useAuth: true,
    });
    expect(lastAuth).toBe('Bearer top-secret-value-0000');
    expect(sent.json()).toMatchObject({
      status: 200,
      check: {
        verdict: 'mismatch',
        issues: [{ path: '$.total', kind: 'type', expected: 'number', actual: 'string' }],
      },
    });
    const history = await app.inject({
      method: 'GET',
      url: `/api/api-explorer/history?path=${encodeURIComponent(project)}`,
    });
    expect(history.json()).toMatchObject([{ status: 200, verdict: 'mismatch' }]);
    expect(history.body).not.toContain('top-secret');
    expect(readFileSync(join(appData, 'api-explorer.json'), 'utf8')).not.toContain('top-secret');
    const cleared = await post('/api/api-explorer/history/clear', { path: project });
    expect(cleared.json()).toEqual([]);
    await post('/api/api-explorer/settings', { path: project, auth: null }, 'PUT');
    expect((await info()).auth).toBeUndefined();
  });

  it('порт, запрещённый для fetch, — 400 с видом и кодом, не 500', async () => {
    const failed = await post('/api/api-explorer/send', {
      path: project,
      method: 'get',
      url: 'http://127.0.0.1:6000/x',
      headers: [],
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({
      code: 'api-send-failed',
      kind: 'bad-url',
      detail: 'bad-port',
    });
  });
});
