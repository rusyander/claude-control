import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { UserRoute } from '@agentdeck/contracts/core/config';
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../../adapters/index.ts';
import { buildCoreRoutes } from '../../../bootstrap/core-routes.ts';
import type { CoreHomeLayout } from '../../../platform/core-home.ts';
import { createUserRoute, downReason, USER_SERVER_DOWN, userOrigin } from './user.ts';

/**
 * Маршрут сервера человека — по настоящему проводу: «llama-server» здесь — сценарий общей
 * заглушки (P120) с путями `/health` и `/v1/models` llama-server; ядро ходит к нему `fetch`
 * процесса. Ничего, кроме HTTP: сервер человека переживает и пробу, и аренду, и освобождение.
 */

const stubs: StubModel[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

/** Сценарий «llama-server»: `/health` как у него (200 `{status:'ok'}` или 503 «грузится»). */
async function stubLlama(health: 200 | 503 = 200, models = ['qwen3-0.6b']) {
  const paths: string[] = [];
  const stub = await startStubModel({
    models,
    script: () => ({ text: 'hi' }),
    route: ({ path }) => {
      paths.push(path);
      if (path !== '/health') return undefined;
      return {
        status: health,
        body: health === 200 ? { status: 'ok' } : { error: { message: 'Loading model' } },
      };
    },
  });
  stubs.push(stub);
  return Object.assign(stub, { paths });
}

/** Порт, на котором заведомо никто не слушает: заняли у ОС и сразу отдали. */
async function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const record = {} as RouteRecorder;
const spec = (model: string) => ({ taskId: 't1', model, signal: new AbortController().signal });

function route(baseUrl: string, extra: Partial<UserRoute> = {}): UserRoute {
  return { id: 'llama', baseUrl, dialect: 'openai-chat', ...extra };
}

describe('local:user — HTTP only', () => {
  it('a live server: up, models from /v1/models, endpoint is the server origin, key goes by NAME', async () => {
    const stub = await stubLlama();
    const r = createUserRoute({
      route: route(`${stub.baseUrl}/v1/`, { keyVar: 'LLAMA_KEY' }),
      env: { LLAMA_KEY: 'k' },
    });
    expect(r.id).toBe('local:user:llama');
    expect(r.kind).toBe('local');
    expect(await r.read.availability()).toEqual({ value: { state: 'up' } });
    expect(await r.read.models()).toEqual({ value: [{ id: 'qwen3-0.6b' }] });
    expect(await r.read.credential()).toEqual({ value: { kind: 'env', present: true } });
    expect(await r.read.price('qwen3-0.6b')).toEqual({ value: { unit: 'none' } });
    expect(r.caps).toMatchObject({ dialects: ['openai-chat'], offline: true });
    const lease = await r.acquire(spec('qwen3-0.6b'), record);
    expect(await r.endpoint(lease, record)).toEqual({
      baseUrl: stub.baseUrl.replace(/\/+$/, ''),
      dialect: 'openai-chat',
      keyRef: { kind: 'env', name: 'LLAMA_KEY' },
    });
    // Проба ходила по путям llama-server, а не «куда-нибудь».
    expect(stub.paths).toEqual(expect.arrayContaining(['/health', '/v1/models']));
  });

  it('the key variable unset in the core env is a credential fact `absent`, never a key value', async () => {
    const stub = await stubLlama();
    const r = createUserRoute({ route: route(stub.baseUrl, { keyVar: 'LLAMA_KEY' }), env: {} });
    expect(await r.read.credential()).toEqual({ value: { kind: 'env', present: false } });
    const keyless = createUserRoute({ route: route(stub.baseUrl), env: {} });
    expect(await keyless.read.credential()).toEqual({ value: { kind: 'none', present: true } });
    const lease = await keyless.acquire(spec('qwen3-0.6b'), record);
    expect((await keyless.endpoint(lease, record))?.keyRef).toBeNull();
  });

  it('a server that does not answer is `absent` with reason user_server_down — and nothing starts it', async () => {
    const port = await deadPort();
    const reasons: string[] = [];
    const r = createUserRoute({
      route: route(`http://127.0.0.1:${port}`),
      probeTimeoutMs: 1_500,
      onDown: (why) => reasons.push(why),
    });
    expect(await r.read.availability()).toEqual({ absent: true });
    expect(r.lastProbe()).toMatch(new RegExp(`^${USER_SERVER_DOWN}: `));
    expect(reasons).toHaveLength(1);
    // Ядро сервер не подняло: порт как был пуст, так и пуст.
    const again = createUserRoute({ route: route(`http://127.0.0.1:${port}`) });
    expect(await again.read.availability()).toEqual({ absent: true });
  });

  it('health 503 (model still loading) is down; an HTML page on /v1/models is unknown, not down', async () => {
    const loading = await stubLlama(503);
    const r = createUserRoute({ route: route(loading.baseUrl) });
    expect(await r.read.availability()).toEqual({ absent: true });
    expect(r.lastProbe()).toContain('503');

    const html = await startStubModel({
      route: ({ path }) =>
        path === '/v1/models'
          ? { status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' }
          : undefined,
    });
    stubs.push(html);
    const notApi = createUserRoute({ route: route(html.baseUrl) });
    const fact = await notApi.read.availability();
    expect('unknown' in fact).toBe(true);
  });

  it('only a known «down» is absent: a refused key or an unnamed network error stays unknown (P44)', async () => {
    const refusedKey = await startStubModel({
      route: ({ path }) => (path === '/v1/models' ? { status: 401, body: '{}' } : undefined),
    });
    stubs.push(refusedKey);
    const keyed = createUserRoute({ route: route(refusedKey.baseUrl) });
    // 401 без ключа — «закрыто ключом»: список не прочитан, но сервер жив — up.
    expect(await keyed.read.availability()).toEqual({ value: { state: 'up' } });

    const dns = createUserRoute({
      route: route('http://127.0.0.1:1'),
      fetch: () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
    });
    const fact = await dns.read.availability();
    expect('unknown' in fact).toBe(true);
    expect(dns.lastProbe()).toBeUndefined();

    expect(downReason(Object.assign(new Error('no answer'), { code: 'timeout' }))).toBe(
      'no answer',
    );
    expect(downReason(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'connection refused',
    );
    expect(downReason(Object.assign(new Error('x'), { code: 'key-refused' }))).toBeUndefined();
  });

  it('models named in the config are the catalog — the list is not read', async () => {
    const stub = await stubLlama();
    const r = createUserRoute({ route: route(stub.baseUrl, { models: ['a', 'b'] }) });
    expect(await r.read.models()).toEqual({ value: [{ id: 'a' }, { id: 'b' }] });
    expect(stub.paths).not.toContain('/v1/models');
  });

  it('release leaves the user server running: it still answers after the lease is gone', async () => {
    const stub = await stubLlama();
    const r = createUserRoute({ route: route(stub.baseUrl) });
    const lease = await r.acquire(spec('qwen3-0.6b'), record);
    expect(await r.release(lease, record)).toEqual({ verified: [], leaks: [] });
    const after = await fetch(`${stub.baseUrl}/health`);
    expect(after.status).toBe(200);
  });

  it('the module holds no process API: it cannot start, stop or kill the user server', () => {
    const source = readFileSync(fileURLToPath(new URL('./user.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/node:child_process|['"]child_process['"]/);
    expect(source).not.toMatch(/process\.kill|\bspawn\(|\bexec(File)?\(|\bfork\(/);
    expect(source).not.toMatch(/platform\/(spawn|process|proc)|keeper|killTree|killChildTree/);
  });

  it('the address loses a trailing /v1 so the CLI never gets /v1/v1', () => {
    expect(userOrigin('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080');
    expect(userOrigin(' http://box:8080 ')).toBe('http://box:8080');
  });

  it('config routes.localUser becomes a local:user route in the core registry', async () => {
    const stub = await stubLlama();
    const registry = buildCoreRoutes(createAdapterRegistry(), { root: '/h' } as CoreHomeLayout, {
      localUser: [route(stub.baseUrl), { ...route(stub.baseUrl), id: 'box' }],
    });
    const found = registry.get('local:user:llama');
    expect(found?.kind).toBe('local');
    expect(registry.get('local:user:box')).toBeDefined();
    expect(await found?.read.availability()).toEqual({ value: { state: 'up' } });
  });
});
