import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { startContourStub, type ContourStub } from '@agentdeck/stub-model/scenarios/contour';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetFetch } from '../../platform/net/net.types.ts';
import { chooseGatewayModel, createGatewayRoute, gatewayRouteId } from './gateway.ts';
import type { GatewayProfile, GatewayRouteOptions } from './gateway.types.ts';

/**
 * Маршрут шлюза контура против стаб-контура пакета (P120, тот же провод, что у свипов панели):
 * доступность — проба каталога, модели и окно контекста — из каталога, цена — только объявленная,
 * предел — бюджет контура. P111 — каждое чтение на сбое (срок, ENOENT хранилища ключей, 5xx,
 * мусор) даёт `unknown` с действием; «нет» — только выключенный человеком контур.
 */

let stub: ContourStub;
beforeAll(async () => {
  stub = await startContourStub({ port: 0 });
});
afterAll(async () => {
  await stub.close();
});

const profile = (over: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: 'corp',
  title: 'Corp',
  driver: 'openai-compat',
  baseUrl: stub.url,
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  caCertPath: '',
  transport: defaultPlatformTransport(),
  ...over,
});

function gateway(over: Partial<GatewayRouteOptions> = {}, p: Partial<GatewayProfile> = {}) {
  return createGatewayRoute({
    profile: profile(p),
    credentialPresent: () => true,
    fetch: globalThis.fetch as NetFetch,
    // Настоящая заглушка контура под общим прогоном отвечала дольше 50 мс (30.10); короткий срок —
    // только у случая «висит», где ответа не будет вовсе.
    probeTimeoutMs: 2_000,
    ...over,
  });
}

const reply =
  (status: number, body: string, type = 'application/json'): NetFetch =>
  async () =>
    new Response(body, { status, headers: { 'content-type': type } });
const hanging: NetFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
const actionOf = (r: ReturnType<typeof gateway>, fact: string) =>
  r.facts.find((decl) => decl.fact === fact)?.onUnknown;

describe('routes/gateway on the stub contour (R:PR-01, P111)', () => {
  it('availability: catalog answers → up; disabled by the human → absent, no network', async () => {
    const before = stub.calls.length;
    expect(await gateway().read.availability()).toEqual({ value: { state: 'up' } });
    expect(stub.calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
    expect(stub.calls.at(-1)?.authorization).toBeUndefined();
    expect(await gateway({}, { enabled: false }).read.availability()).toEqual({ absent: true });
    expect(stub.calls.length).toBe(before + 1);
    expect(gateway().id).toBe(gatewayRouteId('corp'));
  });

  it.each([
    ['timeout', hanging, /^timeout/],
    ['5xx', reply(500, 'oops', 'text/plain'), /^not-ready/],
    ['garbage', reply(200, 'not json', 'text/plain'), /^garbage/],
    ['refused port', undefined, /fetch failed|ECONNREFUSED/],
  ] as const)('availability %s → unknown + retry-until, never absent', async (_n, fetch, why) => {
    const r = fetch
      ? gateway({ fetch, probeTimeoutMs: 50 })
      : gateway({}, { baseUrl: 'http://127.0.0.1:9' });
    expect(await r.read.availability()).toEqual({ unknown: expect.stringMatching(why) });
    expect(actionOf(r, 'availability')).toBe('retry-until');
  });

  it('models + context from the catalog; embedding models left out', async () => {
    const models = await gateway().read.models();
    if (!('value' in models)) throw new Error(`models unread: ${JSON.stringify(models)}`);
    const ids = models.value.map((m) => m.id);
    expect(ids).toContain('stub-chat');
    expect(ids).not.toContain('stub-embed');
    expect(models.value.find((m) => m.id === 'stub-chat')).toMatchObject({
      contextTokens: 128000,
      tools: true,
      images: false,
    });
    expect(await gateway().read.context('stub-chat')).toEqual({ value: 128000 });
  });

  it('price: declared by the catalog → money; not declared → tokens only, never guessed', async () => {
    const priced = gateway({}, { baseUrl: `${stub.url}/openrouter`, defaultModel: 'stub-chat' });
    expect(await priced.read.price('stub-chat')).toEqual({
      value: { unit: 'money', source: 'contour-catalog' },
    });
    expect(await gateway().read.price('stub-chat')).toEqual({ value: { unit: 'none' } });
  });

  it('model choice is the panel rule: map, then catalog, replacement named', () => {
    const catalog = [{ id: 'stub-chat' }, { id: 'stub-tools' }];
    expect(
      chooseGatewayModel(profile({ modelMap: { opus: 'stub-tools' } }), catalog, 'opus'),
    ).toMatchObject({ model: 'stub-tools' });
    expect(chooseGatewayModel(profile(), catalog, 'claude-unknown')).toMatchObject({
      model: 'stub-chat',
    });
  });

  it('keyed catalog through the hop port: hop-injected keyRef, driver auth placement', async () => {
    const asked: unknown[] = [];
    const r = gateway({
      fetch: reply(401, '{}'),
      keyedProbe: async (request) => {
        asked.push(request);
        const res = await fetch(request.url);
        return { status: res.status, body: await res.text() };
      },
    });
    const models = await r.read.models();
    expect('value' in models && models.value.length).toBeGreaterThan(3);
    expect(asked[0]).toMatchObject({
      routeId: 'gateway:corp',
      keyRef: { kind: 'hop-injected', tag: 'gateway:corp' },
      auth: { header: 'authorization', scheme: 'Bearer' },
    });
    const locked = gateway({ fetch: reply(401, '{}') });
    expect(await locked.read.models()).toEqual({
      unknown: 'contour catalog is locked by the key and no keyed probe port is wired',
    });
  });

  it('credential: ENOENT / garbage store → unknown + refuse; present read as is', async () => {
    const broken = gateway({
      credentialPresent: () => {
        throw Object.assign(new Error('ENOENT: provider-keys.json'), { code: 'ENOENT' });
      },
    });
    expect(await broken.read.credential()).toEqual({ unknown: expect.stringMatching(/^ENOENT/) });
    expect(actionOf(broken, 'credential')).toBe('refuse');
    expect(await gateway({ credentialPresent: () => false }).read.credential()).toEqual({
      value: { kind: 'hop-injected', present: false },
    });
  });

  it('limit: contour budget; 402 exhaustion is a hop fact; hop read fails → unknown', async () => {
    expect(await gateway().read.limit()).toEqual({ value: { kind: 'budget' } });
    expect(await gateway({ hopStatus: async () => ({ exhaustedAt: 7 }) }).read.limit()).toEqual({
      value: { kind: 'budget', exhaustedAt: 7 },
    });
    const down = gateway({
      hopStatus: async () => {
        throw new Error('hop host not running');
      },
    });
    expect(await down.read.limit()).toEqual({ unknown: 'hop host not running' });
  });

  it('endpoint: only through the hop; not wired → recorded refusal and null', async () => {
    const decisions: unknown[] = [];
    const recorder = { decision: async (d: unknown) => void decisions.push(d) } as RouteRecorder;
    const r = gateway();
    const lease = await r.acquire({ model: 'stub-chat' } as never, recorder);
    expect(await r.endpoint(lease, recorder)).toBeNull();
    expect(decisions).toEqual([
      expect.objectContaining({ class: 'endpoint', output: { kind: 'refuse' } }),
    ]);
    const wired = gateway({
      hopEndpoint: async () => ({
        baseUrl: 'http://127.0.0.1:1/x',
        dialect: 'openai-chat',
        keyRef: { kind: 'hop-injected', tag: 't' },
      }),
    });
    expect(await wired.endpoint(lease, recorder)).toMatchObject({ dialect: 'openai-chat' });
    expect(await r.release(lease, recorder)).toEqual({ verified: [], leaks: [] });
  });
});
