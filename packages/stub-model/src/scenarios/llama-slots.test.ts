import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { llamaSlotsRoute, startLlamaSlotsStub, type LlamaSlotsStub } from './llama-slots.mjs';

/**
 * Грань llama-server над пакетом (P120): ленту хода звена проверяют на ней, а не на своём
 * сервере проверки. Здесь — по настоящему HTTP: опрос берёт шаг ленты на `/health`, `/slots`
 * отвечает тем же шагом в форме llama-server, `count_tokens` — заданным числом, модельный путь
 * отвечает сам пакет, след пакета называет каждое обращение к `/slots`.
 */

let stub: LlamaSlotsStub | undefined;
let dir: string | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as unknown };
};

describe('stub-model llama-slots facet', () => {
  it('each /health takes the next step, /slots answers that step in llama-server shape, the last step holds', async () => {
    stub = await startLlamaSlotsStub({
      nCtx: 8192,
      timeline: [
        { health: 'loading' },
        { health: 'ok', slot: { processing: true, filled: 2048 } },
        { health: 'ok', slot: { processing: true, filled: 4096, decoded: 10 }, repeat: 2 },
        { health: 'down' },
      ],
    });
    expect((await get(`${stub.url}/health`)).status).toBe(503);
    expect((await get(`${stub.url}/health`)).status).toBe(200);
    expect((await get(`${stub.url}/slots?model=m`)).body).toEqual([
      {
        id: 0,
        n_ctx: 8192,
        is_processing: true,
        n_prompt_tokens: 2048,
        next_token: [{ has_next_token: true, n_remain: -1, n_decoded: 0 }],
      },
    ]);
    // `/slots` без нового `/health` — тот же шаг: один опрос видит одно состояние.
    expect(
      ((await get(`${stub.url}/slots`)).body as { n_prompt_tokens: number }[])[0],
    ).toMatchObject({ n_prompt_tokens: 2048 });
    await get(`${stub.url}/health`);
    await get(`${stub.url}/health`);
    expect(((await get(`${stub.url}/slots`)).body as { next_token: unknown[] }[])[0]).toMatchObject(
      {
        n_prompt_tokens: 4096,
        next_token: [{ n_decoded: 10 }],
      },
    );
    expect((await get(`${stub.url}/health`)).status).toBe(500);
    expect((await get(`${stub.url}/health`)).status).toBe(500);
    expect(stub.hits).toEqual({ health: 6, slots: 3, count: 0 });

    stub.play([{ health: 'ok', slot: { processing: false } }]);
    expect((await get(`${stub.url}/health`)).status).toBe(200);
    expect(
      ((await get(`${stub.url}/slots`)).body as { is_processing: boolean }[])[0]?.is_processing,
    ).toBe(false);
  });

  it('count_tokens answers the given total, else falls through to the package count; model paths stay the package', async () => {
    stub = await startLlamaSlotsStub({ promptTotal: 4096, script: ['hello'] });
    const count = await fetch(`${stub.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(await count.json()).toEqual({ input_tokens: 4096 });
    const reply = await fetch(`${stub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    expect(JSON.stringify(await reply.json())).toContain('hello');
    expect(stub.hits.count).toBe(1);

    const facet = llamaSlotsRoute();
    expect(
      facet.route({
        method: 'POST',
        path: '/v1/messages/count_tokens',
        query: '',
        headers: {},
        raw: '',
        body: undefined,
      }),
    ).toBeUndefined();
    expect(facet.hits.count).toBe(1);
  });

  it('the package trace names every /slots hit as a route line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llama-slots-'));
    const trace = join(dir, 'trace.jsonl');
    stub = await startLlamaSlotsStub({
      trace,
      timeline: [{ health: 'ok', slot: { processing: true } }],
    });
    await get(`${stub.url}/health`);
    await get(`${stub.url}/slots`);
    await get(`${stub.url}/slots`);
    const lines = readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; path: string });
    expect(lines.filter((line) => line.kind === 'route' && line.path === '/slots')).toHaveLength(2);
  });

  it('a bad timeline is refused, not played', () => {
    expect(() => llamaSlotsRoute({ timeline: {} as never })).toThrow(/timeline must be an array/);
    expect(() => llamaSlotsRoute({ timeline: [{ health: 'ok', repeat: 0 }] })).toThrow(/repeat/);
  });
});
