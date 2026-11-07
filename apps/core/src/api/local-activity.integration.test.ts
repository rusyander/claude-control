import type { HopActivity, HopControlReply } from '@agentdeck/contracts/core/hops';
import { llamaSlotsRoute, type LlamaSlotsFacet } from '@agentdeck/stub-model/scenarios/llama-slots';
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicBody, ask, hopStand, type HopStand } from '../hop-host/__fixtures__/hop-stand.ts';
import { hopControl } from '../routes/hops/hops.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';
import type { LocalActivityPort } from './local-activity.ts';

/**
 * Ход своей модели через ядро (этап 11, W2-5): API ядра → управляющий канал НАСТОЯЩЕГО хоста
 * звеньев → его лента → подставной сервер моделей (`@agentdeck/stub-model`, грань `llama-slots`).
 * Запрос CLI идёт через звено маршрута `local:own`; шаг опроса и предел застоя сокращены.
 */

let api: Stand | undefined;
let hop: HopStand | undefined;
afterEach(async () => {
  hop?.stub.release();
  await api?.close().catch(() => undefined);
  await hop?.close().catch(() => undefined);
  api = undefined;
  hop = undefined;
});

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function hopWith(facet: LlamaSlotsFacet, stallMs = 60_000): Promise<HopStand> {
  return hopStand({
    script: { fallback: { text: 'ok', holdMs: Infinity } },
    reply: (request) => facet.route(request),
    deps: { activity: { intervalMs: 40, stallMs } },
  });
}

function portOf(stand: HopStand): LocalActivityPort {
  return { control: (request) => hopControl(stand.handle, request), pollMs: 20 };
}

/** Кадры `event: activity` потока, пока его не закроют. */
function follow(url: string, token: string): { frames: HopActivity[][]; stop(): void } {
  const frames: HopActivity[][] = [];
  const abort = new AbortController();
  void (async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (block.includes('event: activity') && data)
          frames.push((JSON.parse(data.slice(6)) as { routes: HopActivity[] }).routes);
        end = buffer.indexOf('\n\n');
      }
    }
  })().catch(() => undefined);
  return { frames, stop: () => abort.abort() };
}

describe('core local activity api', () => {
  it('streams loading, prompt 2048 of 4096, generating 10 then 120 from the real hop', async () => {
    const facet = llamaSlotsRoute({
      timeline: [
        { health: 'loading', repeat: 4 },
        { health: 'ok', slot: { processing: true, filled: 2048 }, repeat: 4 },
        { health: 'ok', slot: { processing: true, filled: 4096, decoded: 10 }, repeat: 4 },
        { health: 'ok', slot: { processing: true, filled: 4096, decoded: 120 } },
      ],
      promptTotal: 4096,
    });
    hop = await hopWith(facet);
    api = await startStand(undefined, { localActivity: () => portOf(hop as HopStand) });

    const idle = await api.get('/v1/local/activity');
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ routes: [] });

    const stream = follow(`${api.url}/v1/local/activity/stream`, TOKENS.core);
    const { port, placeholder } = await hop.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('long prompt'));
    const seen = (): HopActivity[] =>
      stream.frames
        .map((routes) => routes[0])
        .filter((item): item is HopActivity => item !== undefined);
    await until(
      () => seen().some((a) => a.phase === 'generating' && a.decoded === 120),
      'generating 120',
    );
    stream.stop();
    const phases = seen().map((a) => a.phase);
    expect(phases.indexOf('loading')).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf('prompt')).toBeGreaterThan(phases.indexOf('loading'));
    expect(phases.lastIndexOf('generating')).toBeGreaterThan(phases.indexOf('prompt'));
    expect(seen().find((a) => a.phase === 'prompt')).toMatchObject({
      route: 'local:own',
      inFlight: 1,
      prompt: { filled: 2048, total: 4096 },
    });
    expect(seen().some((a) => a.phase === 'generating' && a.decoded === 10)).toBe(true);
    // Кадр — только на смену вида: опрос ядра (20 мс) чаще шага звена (40 мс), повторов нет.
    const wire = stream.frames.map((routes) => JSON.stringify(routes));
    expect(wire.filter((frame, index) => index > 0 && frame === wire[index - 1])).toEqual([]);

    const now = await api.get('/v1/local/activity');
    expect(((await now.json()) as { routes: HopActivity[] }).routes[0]).toMatchObject({
      phase: 'generating',
      decoded: 120,
      stalled: false,
    });

    hop.stub.release();
    await answer;
    await until(() => hop?.host.ctx.activity?.snapshot()[0]?.inFlight === 0, 'flight closed');
    const after = { ...facet.hits };
    await new Promise((done) => setTimeout(done, 300));
    // Ничего в полёте — сервер моделей не опрашивается вовсе.
    expect(facet.hits).toEqual(after);
    const done = await api.get('/v1/local/activity');
    expect(((await done.json()) as { routes: HopActivity[] }).routes[0]).toMatchObject({
      phase: 'idle',
      inFlight: 0,
    });
    // Простой поток: первый кадр сразу, дальше вид не меняется — кадров больше нет.
    const quiet = follow(`${api.url}/v1/local/activity/stream`, TOKENS.core);
    await until(() => quiet.frames.length > 0, 'first idle frame');
    await new Promise((done) => setTimeout(done, 300));
    quiet.stop();
    expect(quiet.frames).toHaveLength(1);
  });

  it('never touches /slots with nothing in flight and calls a stall past the limit', async () => {
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 512 } }],
    });
    hop = await hopWith(facet, 300);
    api = await startStand(undefined, { localActivity: () => portOf(hop as HopStand) });
    await new Promise((done) => setTimeout(done, 200));
    expect((await api.get('/v1/local/activity')).status).toBe(200);
    expect(facet.hits).toEqual({ health: 0, slots: 0, count: 0 });

    const { port, placeholder } = await hop.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('x'));
    const read = async (): Promise<HopActivity | undefined> =>
      ((await (await (api as Stand).get('/v1/local/activity')).json()) as { routes: HopActivity[] })
        .routes[0];
    let last: HopActivity | undefined;
    const deadline = Date.now() + 5_000;
    while (!last?.stalled && Date.now() < deadline) {
      last = await read();
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(last).toMatchObject({ phase: 'prompt', stalled: true, prompt: { filled: 512 } });
    hop.stub.release();
    await answer;
  });

  it('answers 501 without a port or an activity op, 503 when the host is unreachable', async () => {
    api = await startStand();
    const none = await api.get('/v1/local/activity');
    expect(none.status).toBe(501);
    expect(await none.json()).toMatchObject({ error: 'Активность своей модели не подключена' });
    await api.close();

    const refused: HopControlReply = {
      op: 'activity',
      ok: false,
      code: 'bad_request',
      detail: 'op: unknown',
    };
    api = await startStand(undefined, { localActivity: () => ({ control: async () => refused }) });
    const old = await api.get('/v1/local/activity');
    expect(old.status).toBe(501);
    expect(await old.json()).toMatchObject({
      error: 'Хост звеньев не отдаёт активность своей модели',
    });
    expect((await api.get('/v1/local/activity/stream')).status).toBe(501);
    await api.close();

    api = await startStand(undefined, {
      localActivity: () => ({
        control: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    });
    const down = await api.get('/v1/local/activity');
    expect(down.status).toBe(503);
    expect((await api.get('/v1/local/activity/stream')).status).toBe(503);
    expect((await api.get('/v1/local/activity', 'nope')).status).toBe(401);
  });
});
