import { describe, expect, it } from 'vitest';
import type { Route, RouteRecorder, RouteResource } from '@agentdeck/contracts/core/routes';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import { bindLoopback, type BindProbe } from '../platform/ports.ts';
import { createCliLoginRoute } from './cli-login/cli-login.ts';
import { RouteAborted } from './lease.ts';
import { createRouterClient } from './local/own/client.ts';
import { createSlotQueue } from './local/own/slot.ts';
import { presetIni, routerArgs } from './local/own/server.ts';
import { createRouteRegistry } from './registry.ts';
import { createStubRoute } from './stub/stub.ts';

function recorder() {
  const events: string[] = [];
  const resources: RouteResource[] = [];
  const record: RouteRecorder = {
    decision: (d) => void events.push(`decision:${d.class}`),
    created: (r) => {
      resources.push(r);
      events.push(`created:${r.kind}:${r.release}`);
    },
    verified: (rid, fact) => void events.push(`verified:${rid === resources[0]?.rid}:${fact}`),
    leak: (rid, reason) => void events.push(`leak:${rid === resources[0]?.rid}:${reason}`),
  };
  return { record, events, resources };
}

describe('R:PR-09 stub route over packages/stub-model', () => {
  it('R:PR-09 stub route: acquire binds an allocated port, endpoint answers the script, release reads the port back free', async () => {
    const route = createStubRoute({ name: 'hello', script: ['hi from stub'], contextTokens: 8000 });
    expect(route).toMatchObject({ kind: 'stub', id: 'stub:hello' });
    const r = recorder();
    const lease = await route.acquire(
      { taskId: 't', model: 'stub-model', dialect: 'openai-chat', release: 'step-end' },
      r.record,
    );
    expect(r.events).toEqual(['created:stub-server:step-end']);
    const endpoint = await route.endpoint(lease, r.record);
    expect(endpoint).toMatchObject({ dialect: 'openai-chat', keyRef: null });
    // Живой сервер с нашим владельцем на пути личности — без решения в журнале.
    expect(r.events).toEqual(['created:stub-server:step-end']);
    const port = Number(endpoint?.baseUrl.split(':').pop());
    expect(port < 5170 || port > 5180).toBe(true);
    const reply = await fetch(`${endpoint?.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(JSON.stringify(await reply.json())).toContain('hi from stub');
    const outcome = await route.release(lease, r.record);
    expect(outcome.leaks).toEqual([]);
    expect(r.events[1]).toMatch(
      new RegExp(
        `^verified:true:server stopped \\(\\d+ process(es)?\\), port ${port} free after close$`,
      ),
    );
    await expect(route.endpoint(lease, r.record)).rejects.toThrow(/released/);
    // Факты: те же классы чтения, что у любого маршрута.
    expect(route.facts.map((f) => f.readClass)).toEqual([
      'route.availability',
      'route.models',
      'route.limit',
      'route.price',
      'route.credential',
      'route.context',
    ]);
    expect(await route.read.models()).toEqual({ value: [{ id: 'stub-model' }] });
    expect(await route.read.context('stub-model')).toEqual({ value: 8000 });
    expect(await route.read.price('stub-model')).toEqual({ value: { unit: 'none' } });
    expect(await route.read.limit()).toEqual({ value: { kind: 'none' } });
    expect(await route.read.credential()).toEqual({ value: { kind: 'none', present: true } });
    expect(await route.read.availability()).toEqual({ value: { state: 'startable' } });
  });

  it('R:PR-09 stub route: a port still bound after close is a resource.leak, not «probably closed»', async () => {
    let held: { close(): Promise<void> } | undefined;
    // Проба после закрытия видит порт занятым — как если бы закрытие не освободило его.
    let probes = 0;
    const bind: BindProbe = async (port) => {
      probes += 1;
      if (port !== 0) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      const probe = await bindLoopback(0);
      held = probe;
      return probe;
    };
    const route = createStubRoute({ name: 'leaky', script: ['x'], bind });
    const r = recorder();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const outcome = await route.release(lease, r.record);
    expect(outcome.verified).toEqual([]);
    expect(outcome.leaks[0]?.reason).toMatch(/^port \d+ still bound after close: EADDRINUSE$/);
    expect(probes).toBeGreaterThan(1);
    await held?.close().catch(() => undefined);
    expect(await route.read.context('stub-model')).toEqual({ absent: true });
  });
});

describe('R:PR-08 route registry — iterate, never name', () => {
  it('R:PR-08 registry: duplicate and empty ids refused, unknown id names the known ones, kinds filter', () => {
    const a = createStubRoute({ name: 'a', script: ['x'] });
    const b = createCliLoginRoute({ id: 'adapter-x' });
    const registry = createRouteRegistry([a, b]);
    expect(registry.list().map((route) => route.id)).toEqual(['stub:a', 'cli-login:adapter-x']);
    expect(registry.ofKind('stub')).toEqual([a]);
    expect(registry.get('stub:a')).toBe(a);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.require('cli-login:adapter-x')).toBe(b);
    expect(() => registry.require('nope')).toThrow(
      'unknown route id nope; known: stub:a, cli-login:adapter-x',
    );
    expect(() => createRouteRegistry([a, a])).toThrow('duplicate route id stub:a');
    expect(() => createRouteRegistry([{ ...a, id: ' ' } as Route])).toThrow('empty id');
  });
});

describe('R:PR-03 cli-login route — no endpoint, the CLI own login', () => {
  it('R:PR-03 cli-login over every CLI of the registry: endpoint null, binding to its adapter, window per documented event, never money', async () => {
    for (const facts of CLI_RUN_FACTS) {
      const route = createCliLoginRoute(facts);
      expect(route.caps.binding).toEqual({ via: 'cli-login', adapter: facts.id });
      expect(route.caps.dialects).toEqual([]);
      expect(route.caps.maskable).toBe(false);
      const lease = await route.acquire({ taskId: 't', model: 'm' }, recorder().record);
      expect(lease.resources).toEqual([]);
      const r = recorder();
      expect(await route.endpoint(lease, r.record)).toBeNull();
      // Адреса нет по устройству маршрута — решения о живости нет.
      expect(r.events).toEqual([]);
      expect(await route.release(lease, recorder().record)).toEqual({ verified: [], leaks: [] });
      expect(await route.read.limit()).toEqual({
        value: { kind: 'window', source: facts.windowEvent ? 'in-band-event' : 'unknown' },
      });
      expect(await route.read.price('m')).toEqual({ value: { unit: 'window' } });
    }
    const plain = createCliLoginRoute({ id: 'x' });
    expect(plain.facts.find((f) => f.fact === 'availability')?.onUnknown).toBe('run');
    expect(await plain.read.availability()).toEqual({ unknown: 'no documented login-state read' });
    expect(await plain.read.credential()).toEqual({
      unknown: 'cli store is never read by the core',
    });
    expect(await plain.read.models()).toEqual({ unknown: 'adapter names no models' });
    expect(await plain.read.context('m')).toHaveProperty('unknown');
    const known = createCliLoginRoute(
      { id: 'y' },
      { loginState: async () => false, models: ['m1'] },
    );
    expect(await known.read.availability()).toEqual({ absent: true });
    expect(await known.read.models()).toEqual({ value: [{ id: 'm1' }] });
    // Вход CLI не разбирается DLP-звеном никогда (F-93): см. cli-login.test.ts.
    expect(known.caps.maskable).toBe(false);
    const up = createCliLoginRoute({ id: 'z' }, { loginState: async () => true });
    expect(await up.read.availability()).toEqual({ value: { state: 'up' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      up.acquire({ taskId: 't', model: 'm', signal: controller.signal }, recorder().record),
    ).rejects.toBeInstanceOf(RouteAborted);
  });
});

describe('R:PR-04 own server pieces — slot queue, preset, router client', () => {
  it('R:PR-04 slot queue: FIFO hand-over without a gap, abort leaves the queue, double release is a no-op', async () => {
    const slots = createSlotQueue();
    const first = await slots.acquire('gpu');
    const order: string[] = [];
    const second = slots.acquire('gpu').then((hold) => (order.push('second'), hold));
    const third = slots.acquire('gpu').then((hold) => (order.push('third'), hold));
    expect(slots.waiting('gpu')).toBe(2);
    first.release();
    first.release();
    const h2 = await second;
    expect(slots.held('gpu')).toBe(true);
    expect(slots.waiting('gpu')).toBe(1);
    h2.release();
    (await third).release();
    expect(order).toEqual(['second', 'third']);
    expect(slots.held('gpu')).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    await expect(slots.acquire('gpu', aborted.signal)).rejects.toBeInstanceOf(RouteAborted);
    expect(slots.held('gpu')).toBe(false);
    // Другой ключ — своя очередь.
    const x = await slots.acquire('a');
    const y = await slots.acquire('b');
    x.release();
    y.release();
  });

  it('R:PR-04 preset INI and router args: one section per model, loopback, no autoload, at most one model', () => {
    expect(
      presetIni([
        { id: 'm1', path: 'C:\\models\\a.gguf' },
        { id: 'm2', path: '/b.gguf' },
      ]),
    ).toBe('[m1]\nmodel = C:\\models\\a.gguf\n\n[m2]\nmodel = /b.gguf\n');
    expect(() => presetIni([{ id: 'bad]', path: 'x' }])).toThrow(/line break or bracket/);
    expect(routerArgs('/p.ini', 4242)).toEqual([
      '--models-preset',
      '/p.ini',
      '--models-max',
      '1',
      '--no-models-autoload',
      '--host',
      '127.0.0.1',
      '--port',
      '4242',
      '--no-webui',
    ]);
  });

  it('R:PR-04 router client: /models shape parsed, failed load named with exit code, HTTP error and garbage named', async () => {
    // load/unload сначала читают `/models` (имя секции пресета, `model-id.ts`): очередь ответов
    // держит и это чтение — первое у load, третье (перед HTTP 500) у unload.
    const answers: Record<string, unknown[]> = {
      '/models': [
        { data: [{ id: 'm', status: { value: 'loading' } }] },
        { data: [{ id: 'm', status: { value: 'unloaded', failed: true, exit_code: 7 } }] },
        { data: [{ id: 'm', status: { value: 'unloaded' } }] },
      ],
    };
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/health') return new Response('nope', { status: 503 });
      if (path === '/models/load') return new Response(JSON.stringify({ success: true }));
      if (path === '/models/unload') return new Response('boom', { status: 500 });
      const next = answers[path]?.shift();
      return new Response(next === undefined ? '{"x":1}' : JSON.stringify(next));
    }) as typeof fetch;
    const client = createRouterClient('http://127.0.0.1:1', { fetchImpl, pollMs: 1 });
    expect(await client.healthy()).toBe(false);
    await expect(client.load('m', 1_000)).rejects.toThrow('router failed to load m (exit 7)');
    await expect(client.unload('m', 1_000)).rejects.toThrow('router /models/unload: HTTP 500 boom');
    await expect(client.models()).rejects.toThrow('router /models: no data array');
    answers['/models'] = [{ data: [{ status: {} }] }];
    await expect(client.models()).rejects.toThrow('row without id');
    answers['/models'] = [{ data: [] }, { data: [] }];
    await expect(client.load('m', 1_000)).rejects.toThrow('router does not list m');
    answers['/models'] = Array.from({ length: 50 }, () => ({
      data: [{ id: 'm', status: { value: 'loading' } }],
    }));
    await expect(client.load('m', 5)).rejects.toThrow('router: m loaded not reached in 5 ms');
  });
});
