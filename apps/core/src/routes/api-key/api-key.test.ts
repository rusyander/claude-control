import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { describe, expect, it } from 'vitest';
import type { NetFetch } from '../../platform/net/net.types.ts';
import { apiKeyRouteId, createApiKeyRoute, keyPlacement } from './api-key.ts';
import type { ApiKeyProfile, ApiKeyRouteOptions, KeyedProbeRequest } from './api-key.types.ts';
import { classifyReply, endpointModelsUrl, extractModels } from './probe.ts';

/**
 * P111 таблицей для маршрута ключа API: каждое новое чтение (доступность, модели, предел, цена,
 * доступ, контекст) на сбоях — срок, ENOENT хранилища, 5xx, мусор — даёт `unknown` с причиной и
 * действием, объявленным маршрутом; «нет» — только явное знание (адрес не http(s)).
 */

const PROFILE: ApiKeyProfile = {
  routeId: apiKeyRouteId('anthropic'),
  baseUrl: 'https://api.example.com/',
  apiKind: 'anthropic',
  storeId: 'anthropic',
  keyChannel: 'hop-injected',
};

const reply = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

const fetchOf =
  (make: () => Response | Promise<Response>): NetFetch =>
  async () =>
    make();

/** Висящий запрос, который честно обрывается сигналом — как настоящий fetch на сроке. */
const hanging: NetFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

const enoent = (): never => {
  throw Object.assign(new Error("ENOENT: no such file or directory, open 'provider-keys.json'"), {
    code: 'ENOENT',
  });
};

function route(over: Partial<ApiKeyRouteOptions> = {}, profile: Partial<ApiKeyProfile> = {}) {
  return createApiKeyRoute({
    profile: { ...PROFILE, ...profile },
    credentialPresent: () => true,
    fetch: fetchOf(() => reply(200, { data: [{ id: 'claude-x' }] })),
    probeTimeoutMs: 50,
    ...over,
  });
}

const actionOf = (r: ReturnType<typeof route>, fact: string) =>
  r.facts.find((decl) => decl.fact === fact)?.onUnknown;

describe('routes/api-key fault table (P111)', () => {
  it.each([
    ['timeout', hanging, /^timeout: no answer in 50 ms/],
    ['5xx', fetchOf(() => reply(502, 'bad gateway', 'text/plain')), /^not-ready: .*502/],
    ['503', fetchOf(() => reply(503, {})), /^not-ready/],
    ['429', fetchOf(() => reply(429, {})), /^not-ready/],
    ['garbage', fetchOf(() => reply(200, '<<<not json', 'text/plain')), /^garbage: .*not JSON/],
    ['no list', fetchOf(() => reply(200, { hello: 1 })), /^garbage: JSON without a model list/],
    ['HTML page', fetchOf(() => reply(200, '<html></html>', 'text/html')), /^not-api: .*HTML/],
    ['other 4xx', fetchOf(() => reply(404, {})), /^not-api: .*404/],
    [
      'network',
      fetchOf(() => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }),
      /^ECONNREFUSED/,
    ],
  ] as const)(
    'availability %s → unknown + retry-until, never absent',
    async (_name, fetch, why) => {
      const r = route({ fetch });
      const fact = await r.read.availability();
      expect(fact).toEqual({ unknown: expect.stringMatching(why) });
      expect(actionOf(r, 'availability')).toBe('retry-until');
    },
  );

  it('availability: 401/403 without a key = alive, locked by the key → up', async () => {
    for (const status of [401, 403]) {
      const r = route({ fetch: fetchOf(() => reply(status, { error: 'x' })) });
      expect(await r.read.availability()).toEqual({ value: { state: 'up' } });
    }
  });

  it('availability: a non-http(s) address is explicit knowledge → absent, no network', async () => {
    let called = 0;
    const r = route(
      { fetch: fetchOf(() => (called++, reply(200, { data: [] }))) },
      { baseUrl: 'file:///etc' },
    );
    expect(await r.read.availability()).toEqual({ absent: true });
    expect(called).toBe(0);
  });

  it('credential: ENOENT / broken store → unknown + refuse, never «no key»', async () => {
    const r = route({ credentialPresent: enoent });
    expect(await r.read.credential()).toEqual({ unknown: expect.stringMatching(/^ENOENT/) });
    expect(actionOf(r, 'credential')).toBe('refuse');
    const garbage = route({
      credentialPresent: () => {
        throw Object.assign(new Error('key store is not JSON'), { code: 'store-garbage' });
      },
    });
    expect(await garbage.read.credential()).toEqual({
      unknown: 'store-garbage: key store is not JSON',
    });
    expect(await route({ credentialPresent: () => false }).read.credential()).toEqual({
      value: { kind: 'hop-injected', present: false },
    });
  });

  it('models: keyed probe via the hop port; refused key / 5xx / garbage → unknown + run', async () => {
    const asked: KeyedProbeRequest[] = [];
    const ok = route({
      keyedProbe: async (request) => {
        asked.push(request);
        return { status: 200, body: JSON.stringify({ data: [{ id: 'claude-y' }] }) };
      },
    });
    expect(await ok.read.models()).toEqual({ value: [{ id: 'claude-y' }] });
    expect(asked[0]).toMatchObject({
      url: 'https://api.example.com/v1/models',
      keyRef: { kind: 'hop-injected', tag: PROFILE.routeId },
      auth: { header: 'x-api-key', scheme: '' },
    });
    for (const [status, body, why] of [
      [401, '{}', /^key-refused/],
      [500, '{}', /^not-ready/],
      [200, 'nope', /^garbage/],
    ] as const) {
      const r = route({ keyedProbe: async () => ({ status, body }) });
      expect(await r.read.models()).toEqual({ unknown: expect.stringMatching(why) });
      expect(actionOf(r, 'models')).toBe('run');
    }
    const port = route({
      keyedProbe: async () => {
        throw new Error('hop control socket closed');
      },
    });
    expect(await port.read.models()).toEqual({ unknown: 'hop control socket closed' });
  });

  it('models: no keyed port + locked catalog → unknown named; profile model → that model', async () => {
    const locked = route({ fetch: fetchOf(() => reply(401, {})) });
    expect(await locked.read.models()).toEqual({
      unknown: 'catalog is locked by the key and no keyed probe port is wired',
    });
    const declared = route({ fetch: fetchOf(() => reply(401, {})) }, { model: 'claude-z' });
    expect(await declared.read.models()).toEqual({ value: [{ id: 'claude-z' }] });
    expect(await route().read.models()).toEqual({ value: [{ id: 'claude-x' }] });
  });

  it('limit: rate by default, budget with a user cap, exhaustedAt from the hop; hop read fails → unknown', async () => {
    expect(await route().read.limit()).toEqual({ value: { kind: 'rate' } });
    expect(await route({}, { userCapUsd: 5 }).read.limit()).toEqual({ value: { kind: 'budget' } });
    expect(await route({ hopStatus: async () => ({ exhaustedAt: 42 }) }).read.limit()).toEqual({
      value: { kind: 'budget', exhaustedAt: 42 },
    });
    const broken = route({ hopStatus: enoent });
    expect(await broken.read.limit()).toEqual({ unknown: expect.stringMatching(/^ENOENT/) });
    expect(actionOf(broken, 'limit')).toBe('run');
  });

  it('price: no pricing port → unknown; table names it → money; not named → tokens only', async () => {
    expect(await route().read.price('claude-x')).toEqual({
      unknown: 'no pricing table port wired',
    });
    expect(await route({ priceKnown: () => true }).read.price('claude-x')).toEqual({
      value: { unit: 'money', source: 'pricing-table' },
    });
    expect(await route({ priceKnown: () => false }).read.price('claude-x')).toEqual({
      value: { unit: 'none' },
    });
  });

  it('context: not declared by the catalog → unknown named; catalog down → unknown', async () => {
    expect(await route().read.context('claude-x')).toEqual({
      unknown: 'context of claude-x is not declared by the catalog',
    });
    expect(await route({ fetch: hanging }).read.context('claude-x')).toEqual({
      unknown: expect.stringMatching(/^timeout/),
    });
  });

  it('caps and endpoint: hop channel without a hop client → recorded refusal, null; panel-store → direct', async () => {
    const decisions: unknown[] = [];
    const recorder = { decision: async (d: unknown) => void decisions.push(d) } as RouteRecorder;
    const hop = route();
    const lease = await hop.acquire({ model: 'claude-x' } as never, recorder);
    expect(await hop.endpoint(lease, recorder)).toBeNull();
    expect(decisions).toEqual([expect.objectContaining({ class: 'endpoint' })]);
    const direct = route({}, { keyChannel: 'panel-store' });
    expect(await direct.endpoint(lease, recorder)).toEqual({
      baseUrl: 'https://api.example.com',
      dialect: 'anthropic-messages',
      keyRef: { kind: 'panel-store', name: 'anthropic' },
    });
    expect(route({}, { apiKind: 'google' }).caps.maskable).toBe(false);
    expect(route({}, { baseUrl: 'http://127.0.0.1:8080' }).caps.offline).toBe(true);
    expect(hop.caps.offline).toBe(false);
  });

  it('probe helpers: models URL per kind, three list forms, key placement per kind', () => {
    expect(endpointModelsUrl('https://g.example/', 'google')).toBe(
      'https://g.example/v1beta/models',
    );
    expect(endpointModelsUrl('https://o.example/v1', 'openai-compat')).toBe(
      'https://o.example/v1/models',
    );
    expect(extractModels({ models: [{ name: 'models/gemini-x' }] }, 'google')).toEqual([
      'gemini-x',
    ]);
    expect(extractModels({ data: 'x' }, 'openai-compat')).toBeUndefined();
    expect(extractModels(null, 'anthropic')).toBeUndefined();
    expect(keyPlacement('google')).toEqual({ header: 'x-goog-api-key', scheme: '' });
    expect(keyPlacement('openai-compat')).toEqual({ header: 'authorization', scheme: 'Bearer' });
    expect(classifyReply({ status: 401, body: '' }, () => true, false)).toEqual({
      kind: 'locked',
      status: 401,
    });
  });
});
