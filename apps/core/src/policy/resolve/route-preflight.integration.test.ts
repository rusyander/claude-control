import type { Fact } from '@agentdeck/contracts/core/facts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { startContourStub, type ContourStub } from '@agentdeck/stub-model/scenarios/contour';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeFactDecls } from '../../routes/facts.ts';
import { createApiKeyRoute } from '../../routes/api-key/api-key.ts';
import { createGatewayRoute } from '../../routes/gateway/gateway.ts';
import type { GatewayProfile } from '../../routes/gateway/gateway.types.ts';
import type { NetFetch } from '../../platform/net/net.types.ts';
import { preflightRoutes } from './route-preflight.ts';
import type { PreflightRoute } from './route-preflight.types.ts';
import type { AllowedRoute } from './resolve.types.ts';

/**
 * P128: предпроверка по маршруту на настоящих маршрутах ядра против стаб-контура — выбранный
 * маршрут недоступен, ключа нет, памяти карты мало → запуска нет, причина названа вместе с
 * исправлением; годные альтернативы перечислены и НИКОГДА не взяты.
 */

let stub: ContourStub;
beforeAll(async () => {
  stub = await startContourStub({ port: 0 });
});
afterAll(async () => {
  await stub.close();
});

const contour = (over: Partial<GatewayProfile> = {}): GatewayProfile => ({
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

const GW: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'gateway', id: 'gateway:corp' },
  modelPattern: '*',
};
const KEY: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'api-key', id: 'api-key:endpoint:own' },
  modelPattern: '*',
};
const LOCAL: AllowedRoute = {
  adapter: 'qwen',
  route: { kind: 'local', id: 'local:own' },
  modelPattern: 'qwen3-coder',
};

/** Своя модель — подставной маршрут с фактами: память судит порт `memoryFit`. */
const localRoute: PreflightRoute = {
  id: 'local:own',
  kind: 'local',
  facts: routeFactDecls(),
  read: {
    availability: async () => ({ value: { state: 'startable' } }),
    credential: async () => ({ value: { kind: 'none', present: true } }),
  } as PreflightRoute['read'],
};

function registry(opts: { contourUrl?: string; keyPresent?: boolean | 'throws' } = {}) {
  const gateway = createGatewayRoute({
    profile: contour(opts.contourUrl ? { baseUrl: opts.contourUrl } : {}),
    credentialPresent: () => true,
    fetch: globalThis.fetch as NetFetch,
    probeTimeoutMs: 500,
  });
  const apiKey = createApiKeyRoute({
    profile: {
      routeId: KEY.route.id,
      baseUrl: `${stub.url}/v1`,
      apiKind: 'openai-compat',
      storeId: 'endpoint:own',
      keyChannel: 'hop-injected',
    },
    credentialPresent: () => {
      if (opts.keyPresent === 'throws')
        throw Object.assign(new Error('ENOENT: provider-keys.json'), { code: 'ENOENT' });
      return opts.keyPresent ?? true;
    },
    fetch: globalThis.fetch as NetFetch,
    probeTimeoutMs: 500,
  });
  const all: PreflightRoute[] = [gateway, apiKey, localRoute];
  return (id: string) => all.find((route) => route.id === id);
}

describe('policy/resolve route preflight (P128)', () => {
  it('all usable → start, chosen kept, the rest listed as usable alternatives', async () => {
    const verdict = await preflightRoutes({
      chosen: GW,
      allowed: [GW, KEY],
      routeOf: registry(),
    });
    expect(verdict).toMatchObject({ start: true, waits: false, reasons: [] });
    expect(verdict.chosen).toMatchObject({ routeId: 'gateway:corp', status: 'ok' });
    expect(verdict.alternatives.map((row) => row.routeId)).toEqual(['api-key:endpoint:own']);
  });

  it('chosen gateway down → no start, fix named, the usable api-key listed but NOT taken', async () => {
    const verdict = await preflightRoutes({
      chosen: GW,
      allowed: [GW, KEY],
      routeOf: registry({ contourUrl: 'http://127.0.0.1:9' }),
    });
    // Облачная доступность `unknown` — ждать в безопасной точке (P77), а не отказ и не другой
    // маршрут; отказ даёт только явное «нет».
    expect(verdict).toMatchObject({ start: true, waits: true });
    expect(verdict.chosen).toMatchObject({
      routeId: 'gateway:corp',
      status: 'unknown',
      onUnknown: 'retry-until',
    });
    expect(verdict.reasons[0]).toMatch(/units wait at a safe point \(retry-until\)$/);
    const disabled = await preflightRoutes({
      chosen: GW,
      allowed: [GW, KEY],
      routeOf: (id) =>
        id === 'gateway:corp'
          ? createGatewayRoute({
              profile: contour({ enabled: false }),
              credentialPresent: () => true,
            })
          : registry()(id),
    });
    expect(disabled.start).toBe(false);
    expect(disabled.chosen).toMatchObject({
      routeId: 'gateway:corp',
      status: 'fail',
      fix: expect.stringContaining('enable the contour'),
    });
    expect(disabled.alternatives.map((row) => row.routeId)).toEqual(['api-key:endpoint:own']);
    expect(disabled.reasons).toEqual([
      'claude/gateway:corp: gateway:corp is not available',
      expect.stringMatching(/^fix: enable the contour/),
      'alternatives (not taken; choose one with set-route): claude/api-key:endpoint:own',
    ]);
  });

  it('credential absent → no start, key fix named; store unreadable → unknown + refuse, not «no key»', async () => {
    const absent = await preflightRoutes({
      chosen: KEY,
      allowed: [KEY, GW],
      routeOf: registry({ keyPresent: false }),
    });
    expect(absent).toMatchObject({
      start: false,
      chosen: {
        routeId: KEY.route.id,
        status: 'fail',
        fix: expect.stringContaining('add the key'),
      },
    });
    expect(absent.alternatives.map((row) => row.routeId)).toEqual(['gateway:corp']);
    const unread = await preflightRoutes({
      chosen: KEY,
      allowed: [KEY],
      routeOf: registry({ keyPresent: 'throws' }),
    });
    expect(unread).toMatchObject({
      start: false,
      chosen: { status: 'unknown', onUnknown: 'refuse' },
      reasons: [
        expect.stringContaining('credential unread: ENOENT'),
        expect.any(String),
        'no usable alternative in the allowed set',
      ],
    });
  });

  it('local model short of GPU memory → no start with the fit fix; memory unread → run by estimate', async () => {
    const short = await preflightRoutes({
      chosen: LOCAL,
      allowed: [LOCAL, KEY],
      routeOf: registry(),
      memoryFit: async () => ({ short: true, detail: 'needs 20 GiB, 8 GiB free' }),
    });
    expect(short).toMatchObject({
      start: false,
      chosen: {
        routeId: 'local:own',
        status: 'fail',
        fix: expect.stringContaining('smaller model'),
      },
    });
    expect(short.alternatives.map((row) => row.routeId)).toEqual([KEY.route.id]);
    const unread = await preflightRoutes({
      chosen: LOCAL,
      allowed: [LOCAL],
      routeOf: registry(),
      memoryFit: async () => {
        throw new Error('nvidia-smi missing');
      },
    });
    expect(unread).toMatchObject({ start: true, chosen: { status: 'unknown', onUnknown: 'run' } });
    const unwired = await preflightRoutes({ chosen: LOCAL, allowed: [LOCAL], routeOf: registry() });
    expect(unwired.chosen.checks.at(-1)).toMatchObject({ check: 'memory', status: 'not-checked' });
  });

  it('chosen outside the allowed set or unregistered → fail named, only set-route widens', async () => {
    const outside = await preflightRoutes({ chosen: KEY, allowed: [GW], routeOf: registry() });
    expect(outside).toMatchObject({
      start: false,
      chosen: { routeId: KEY.route.id, status: 'fail', fix: expect.stringContaining('set-route') },
    });
    const ghost: AllowedRoute = { ...KEY, route: { kind: 'api-key', id: 'api-key:ghost' } };
    const missing = await preflightRoutes({ chosen: ghost, allowed: [ghost], routeOf: registry() });
    expect(missing.chosen).toMatchObject({ kind: 'unregistered', status: 'fail' });
    const wrongKind: AllowedRoute = { ...KEY, route: { kind: 'local', id: KEY.route.id } };
    const mismatch = await preflightRoutes({
      chosen: wrongKind,
      allowed: [wrongKind],
      routeOf: registry(),
    });
    expect(mismatch.chosen.checks[0]?.detail).toContain('registry kind api-key');
  });

  it('a route reader that throws past readFact is still unknown, never ok', async () => {
    const throwing: PreflightRoute = {
      ...localRoute,
      read: {
        availability: async (): Promise<Fact<{ state: 'up' }>> => {
          throw new Error('reader broke');
        },
        credential: async () => ({ absent: true }),
      } as unknown as PreflightRoute['read'],
    };
    const verdict = await preflightRoutes({
      chosen: LOCAL,
      allowed: [LOCAL],
      routeOf: () => throwing,
    });
    expect(verdict.start).toBe(false);
    expect(verdict.chosen.checks.map((c) => c.status)).toEqual([
      'ok',
      'unknown',
      'fail',
      'not-checked',
    ]);
  });
});
