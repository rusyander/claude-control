import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import {
  addCollection,
  describeExplorer,
  loadSource,
  readProject,
  removeCollection,
  runningServices,
  sendAndRecord,
  setAuth,
} from './api-explorer.ts';
import { forgetProbeCache, findSpecFiles } from './discover.ts';
import { forgetSpecCache, specFilePath } from './load.ts';
import { sendRequest } from './send.ts';
import { HISTORY_LIMIT, maskSecret } from './store.ts';

/**
 * Источники, отправка и история — на настоящем HTTP-сервере на 127.0.0.1 и
 * настоящих файлах во временном каталоге. Подменять тут нечего: сеть — своя
 * петля, хранилище ключей — во временном каталоге данных.
 */

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Live' },
  paths: {
    '/items': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

let server: Server;
let base: string;
let seen: { method?: string; headers: Record<string, unknown>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({ method: request.method, headers: request.headers, body });
      const url = request.url ?? '';
      if (url === '/v3/api-docs') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(SPEC));
      } else if (url.startsWith('/items')) {
        response.setHeader('content-type', 'application/json');
        response.end(url.includes('bad') ? '[{"id":"x"}]' : '[{"id":1}]');
      } else if (url === '/big') {
        response.setHeader('content-type', 'text/plain');
        response.end('x'.repeat(5000));
      } else if (url === '/png') {
        response.setHeader('content-type', 'image/png');
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (url === '/slow') {
        setTimeout(() => response.end('late'), 2000);
      } else {
        response.statusCode = 404;
        response.end('no');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let appData: string;
let root: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'api-explorer-data-'));
  root = mkdtempSync(join(tmpdir(), 'api-explorer-project-'));
  seen = [];
  forgetProbeCache();
  forgetSpecCache();
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const put = (rel: string, content: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};

describe('поиск контракта в проекте', () => {
  it('по имени и по содержимому в каталоге api/, мимо node_modules и чужого JSON', () => {
    put('openapi.yaml', 'openapi: 3.1.0\ninfo: {title: a}\npaths: {}\n');
    put('api/v1/petstore.json', JSON.stringify({ swagger: '2.0', paths: {} }));
    put(
      'docs/calls.postman_collection.json',
      JSON.stringify({
        info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
        item: [],
      }),
    );
    put('api/package.json', '{"name":"x"}');
    put('node_modules/lib/openapi.json', '{"openapi":"3.0.0"}');
    put('src/swagger.json', '{"not":"spec"}');
    put('a/b/c/d/e/openapi.json', '{"openapi":"3.0.0"}');
    expect(findSpecFiles(root)).toEqual([
      'api/v1/petstore.json',
      'docs/calls.postman_collection.json',
      'openapi.yaml',
    ]);
  });

  it('файл вне проекта не читается', () => {
    expect(() => specFilePath(root, '../outside.json')).toThrow(
      expect.objectContaining({ kind: 'missing' }),
    );
  });

  it('работающий сервис опрошен по известным адресам; цели чужого проекта не берутся', async () => {
    const runs = [
      { projectPath: root, name: 'api', status: 'running', url: `${base}/` },
      { projectPath: join(root, '..', 'other'), name: 'x', status: 'running', url: base },
      { projectPath: root, name: 'web', status: 'stopped', url: base },
    ] as ProjectRunnerView[];
    const services = runningServices(root, runs);
    expect(services).toEqual([{ name: 'api', url: base }]);
    const info = await describeExplorer(appData, root, services);
    expect(info.sources).toEqual([
      {
        id: `url:${base}/v3/api-docs`,
        kind: 'url',
        label: `${base}/v3/api-docs`,
        removable: false,
      },
    ]);
    const spec = await loadSource(appData, root, `url:${base}/v3/api-docs`);
    // Своего `servers` у контракта нет — сервер взят из адреса, откуда он пришёл.
    expect(spec.servers).toEqual([base]);
  });
});

describe('отправка', () => {
  it('ответ со статусом, заголовками, временем; тело сверено со схемой', async () => {
    put('openapi.json', JSON.stringify(SPEC));
    const ok = await sendAndRecord(appData, root, {
      method: 'get',
      url: `${base}/items`,
      headers: [['Accept', 'application/json']],
      sourceId: 'file:openapi.json',
      endpointId: 'GET /items',
    });
    expect(ok).toMatchObject({ status: 200, body: '[{"id":1}]', check: { verdict: 'ok' } });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    const bad = await sendAndRecord(appData, root, {
      method: 'get',
      url: `${base}/items?bad=1`,
      headers: [],
      sourceId: 'file:openapi.json',
      endpointId: 'GET /items',
    });
    expect(bad.check).toEqual({
      verdict: 'mismatch',
      against: '200',
      issues: [{ path: '$[0].id', kind: 'type', expected: 'integer', actual: 'string' }],
    });
  });

  it('сохранённая авторизация уходит заголовком, в истории — маской', async () => {
    setAuth(appData, root, { header: 'Authorization', value: 'Bearer secret-token-1234567890' });
    await sendAndRecord(appData, root, {
      method: 'post',
      url: `${base}/echo?api_key=raw-key`,
      headers: [
        ['authorization', 'Bearer from-form'],
        ['Content-Type', 'application/json'],
      ],
      body: '{"a":1}',
      useAuth: true,
    });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer secret-token-1234567890' },
    });
    const [entry] = readProject(appData, root).history ?? [];
    expect(entry).toMatchObject({ status: 404, method: 'post', body: '{"a":1}' });
    expect(entry?.url).toBe(`${base}/echo?api_key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2`);
    expect(entry?.headers).toContainEqual(['Authorization', 'Bearer ••••7890']);
    const file = readFileSync(join(appData, 'api-explorer.json'), 'utf8');
    expect(file).not.toContain('secret-token');
    expect(file).not.toContain('raw-key');
    const info = await describeExplorer(appData, root, []);
    expect(info.auth).toEqual({ header: 'Authorization', masked: 'Bearer ••••7890' });
  });

  it('без useAuth сохранённый заголовок не подставляется', async () => {
    setAuth(appData, root, { header: 'X-Api-Key', value: 'k' });
    await sendAndRecord(appData, root, { method: 'get', url: `${base}/items`, headers: [] });
    expect(seen.at(-1)?.headers['x-api-key']).toBeUndefined();
  });

  it('тело больше предела обрезано, картинка — без текста, сверки нет', async () => {
    const big = await sendRequest({
      method: 'get',
      url: `${base}/big`,
      headers: [],
      capBytes: 1000,
    });
    expect(big).toMatchObject({ bodyTruncated: true, sizeBytes: 5000 });
    expect(big.body).toHaveLength(1000);
    const png = await sendRequest({ method: 'get', url: `${base}/png`, headers: [] });
    expect(png).toMatchObject({ binary: true, body: '', sizeBytes: 4 });
  });

  it('отказ соединения, таймаут, не тот адрес — своим видом и в историю', async () => {
    // Порт, который только что был занят и освобождён, — отказ соединения наверняка.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(
      sendAndRecord(appData, root, {
        method: 'get',
        url: `http://127.0.0.1:${freePort}/x`,
        headers: [],
      }),
    ).rejects.toMatchObject({ kind: 'connect', detail: 'ECONNREFUSED' });
    await expect(
      sendRequest({ method: 'get', url: 'http://127.0.0.1:6000/x', headers: [] }),
    ).rejects.toMatchObject({ kind: 'bad-url', detail: 'bad-port' });
    await expect(
      sendRequest({ method: 'get', url: `${base}/slow`, headers: [], timeoutMs: 200 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    await expect(
      sendRequest({ method: 'get', url: 'file:///etc/passwd', headers: [] }),
    ).rejects.toMatchObject({
      kind: 'bad-url',
    });
    expect(readProject(appData, root).history?.[0]).toMatchObject({ error: 'connect' });
  });

  it(`история — не длиннее ${HISTORY_LIMIT}, новые сверху`, async () => {
    for (let index = 0; index < HISTORY_LIMIT + 3; index++)
      await sendAndRecord(appData, root, {
        method: 'get',
        url: `${base}/items?n=${index}`,
        headers: [],
      });
    const history = readProject(appData, root).history ?? [];
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]?.url).toContain(`n=${HISTORY_LIMIT + 2}`);
  });
});

describe('коллекции Postman', () => {
  const COLLECTION = JSON.stringify({
    info: { _postman_id: '1', name: 'Calls' },
    item: [{ name: 'List', request: { method: 'GET', url: 'http://localhost:1/items' } }],
  });

  it('сохранена, читается только своим проектом, убрана — файл в архиве', async () => {
    const id = addCollection(appData, root, 'Calls', COLLECTION);
    const spec = await loadSource(appData, root, `postman:${id}`);
    expect(spec.endpoints.map((item) => item.id)).toEqual(['GET /items']);
    await expect(
      loadSource(appData, join(root, 'sub-other'), `postman:${id}`),
    ).rejects.toMatchObject({
      kind: 'missing',
    });
    expect(removeCollection(appData, root, id)).toBe(true);
    expect(readFileSync(join(appData, 'api-collections-archive', `${id}.json`), 'utf8')).toBe(
      COLLECTION,
    );
    await expect(loadSource(appData, root, `postman:${id}`)).rejects.toMatchObject({
      kind: 'missing',
    });
  });
});

describe('маска секрета', () => {
  it('схема видна, хвост — только у длинного значения', () => {
    expect(maskSecret('Bearer abcdefghijklmnopqrstu')).toBe('Bearer ••••rstu');
    expect(maskSecret('short')).toBe('••••');
  });
});
