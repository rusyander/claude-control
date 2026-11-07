import { llamaSlotsRoute, type LlamaSlotsFacet } from '@agentdeck/stub-model/scenarios/llama-slots';
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicBody, ask, hopStand, type HopStand } from '../__fixtures__/hop-stand.ts';
import { isLocalRoute } from './activity.ts';
import { advance, isStalled, slotOf, SLOTS_UNANSWERED, type Motion } from './poll.ts';

/**
 * Лента хода локального маршрута (этап 11, W2-5): настоящий хост звеньев, запрос CLI через шлюз
 * звена к подставному серверу моделей (`@agentdeck/stub-model`, грань `llama-slots`). Часы и шаг
 * опроса — теста: опрос идёт вызовом `tick()`, таймер вынесен за час.
 */

let stand: HopStand | undefined;
afterEach(async () => {
  stand?.stub.release();
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

const motion = (over: Partial<Motion> = {}): Motion => ({
  phase: 'queued',
  filled: 0,
  decoded: 0,
  key: '',
  lastMoveAt: 0,
  ...over,
});

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('hop activity poll', () => {
  it('reads the busy slot, else slot 0; a non-array is no slot', () => {
    const body = [
      { id: 0, is_processing: false, n_prompt_tokens: 5 },
      { id: 1, is_processing: true, n_prompt_tokens: 2048, next_token: [{ n_decoded: 7 }] },
    ];
    expect(slotOf(body)).toEqual({ processing: true, filled: 2048, decoded: 7 });
    expect(slotOf([{ id: 0, n_prompt_tokens: 3 }])).toEqual({
      processing: false,
      filled: 3,
      decoded: 0,
    });
    expect(slotOf({ slots: [] })).toBeUndefined();
  });

  it('maps a reading to a phase; silence keeps the phase and the last move', () => {
    expect(advance(motion(), { health: undefined }, 1).phase).toBe('starting');
    const loading = advance(motion(), { health: 'loading' }, 1);
    expect(loading.phase).toBe('loading');
    // Загрузка — живой сервер: каждый ответ 503 «Loading model» — движение, тишина не копится.
    expect(advance(loading, { health: 'loading' }, 4).lastMoveAt).toBe(4);
    expect(advance(motion(), { health: 'ok', slot: undefined }, 1).phase).toBe('queued');
    const prompt = advance(
      motion(),
      { health: 'ok', slot: { processing: true, filled: 2048, decoded: 0 } },
      5,
    );
    expect(prompt).toMatchObject({ phase: 'prompt', filled: 2048, lastMoveAt: 5 });
    const silent = advance(prompt, { health: 'ok', slot: SLOTS_UNANSWERED }, 9);
    expect(silent).toMatchObject({ phase: 'prompt', lastMoveAt: 5 });
    const generating = advance(
      prompt,
      { health: 'ok', slot: { processing: true, filled: 2048, decoded: 1 } },
      9,
    );
    expect(generating).toMatchObject({ phase: 'generating', decoded: 1, lastMoveAt: 9 });
  });

  it('calls a stall only in flight, past the limit, outside start and load', () => {
    const still = motion({ phase: 'prompt', lastMoveAt: 0 });
    expect(isStalled(still, 1, 100, 100)).toBe(true);
    expect(isStalled(still, 1, 99, 100)).toBe(false);
    expect(isStalled(still, 0, 1_000, 100)).toBe(false);
    expect(isStalled({ ...still, phase: 'loading' }, 1, 1_000, 100)).toBe(false);
    expect(isStalled({ ...still, phase: 'starting' }, 1, 1_000, 100)).toBe(false);
  });

  it('knows only local routes', () => {
    expect(isLocalRoute('local:own')).toBe(true);
    expect(isLocalRoute('local:own:panel')).toBe(true);
    expect(isLocalRoute('gateway:local-ollama')).toBe(true);
    expect(isLocalRoute('local:user:ollama')).toBe(false);
    expect(isLocalRoute('route-stub')).toBe(false);
  });
});

describe('hop activity book over the real hop host', () => {
  async function start(facet: LlamaSlotsFacet, clock: { at: number }): Promise<HopStand> {
    return hopStand({
      script: { fallback: { text: 'ok', holdMs: Infinity } },
      reply: (request) => facet.route(request),
      deps: { now: () => clock.at, activity: { intervalMs: 3_600_000, stallMs: 1_000 } },
    });
  }

  it('walks loading, prompt 2048 of 4096, generating 10 then 120, and calls a stall', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({ timeline: [{ health: 'loading' }], promptTotal: 4096 });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('long prompt'));
    await until(() => stand?.stub.holding() === true, 'request held upstream');
    await until(() => facet.hits.health === 1 && facet.hits.count === 1, 'first poll + count');
    await until(() => book.snapshot()[0]?.phase === 'loading', 'loading phase');
    expect(facet.hits.slots).toBe(0);

    facet.play([{ health: 'ok', slot: { processing: true, filled: 2048 } }]);
    clock.at += 2_000;
    await book.tick();
    expect(book.snapshot()).toEqual([
      expect.objectContaining({
        route: 'local:own',
        model: 'stub-model',
        phase: 'prompt',
        inFlight: 1,
        startedAt: 1_000,
        prompt: { filled: 2048, total: 4096 },
        decoded: 0,
        lastMoveAt: 3_000,
        stalled: false,
      }),
    ]);

    facet.play([{ health: 'ok', slot: { processing: true, filled: 4096, decoded: 10 } }]);
    clock.at += 2_000;
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ phase: 'generating', decoded: 10 });

    facet.play([{ health: 'ok', slot: { processing: true, filled: 4096, decoded: 120 } }]);
    clock.at += 2_000;
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ phase: 'generating', decoded: 120, stalled: false });

    // Тот же шаг: сервер жив, движения нет. До предела — не застой, на пределе — застой.
    clock.at += 500;
    await book.tick();
    expect(book.snapshot()[0]?.stalled).toBe(false);
    clock.at += 500;
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ stalled: true, lastMoveAt: 7_000 });

    facet.play([{ health: 'ok', slot: { processing: false } }]);
    clock.at += 2_000;
    await book.tick();
    expect(book.snapshot()[0]?.phase).toBe('queued');

    stand.stub.release();
    expect((await answer).status).toBe(200);
    await until(() => book.snapshot()[0]?.inFlight === 0, 'flight closed');
    expect(book.snapshot()[0]).toMatchObject({ phase: 'idle', inFlight: 0, stalled: false });
    expect(book.snapshot()[0]?.prompt).toBeUndefined();
  });

  it('falls back to the 120 s GPU stall limit of the contract when the host sets none', async () => {
    // Боевой хост предел не задаёт: берётся общий с панелью предел контракта (справка: «2 мин»).
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 100 } }],
      promptTotal: 4096,
    });
    stand = await hopStand({
      script: { fallback: { text: 'ok', holdMs: Infinity } },
      reply: (request) => facet.route(request),
      deps: { now: () => clock.at, activity: { intervalMs: 3_600_000 } },
    });
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('prompt'));
    await until(() => book.snapshot()[0]?.phase === 'prompt', 'prompt phase');
    const moved = book.snapshot()[0]?.lastMoveAt ?? 0;

    clock.at = moved + 119_999;
    await book.tick();
    expect(book.snapshot()[0]?.stalled).toBe(false);
    clock.at = moved + 120_000;
    await book.tick();
    expect(book.snapshot()[0]?.stalled).toBe(true);

    stand.stub.release();
    expect((await answer).status).toBe(200);
  });

  it('never polls the model server while nothing is in flight', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({ timeline: [{ health: 'ok', slot: { processing: true } }] });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    await book.tick();
    expect(facet.hits).toEqual({ health: 0, slots: 0, count: 0 });

    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('hi'));
    await until(() => facet.hits.slots === 1, 'first poll');
    stand.stub.release();
    await answer;
    await until(() => book.snapshot()[0]?.inFlight === 0, 'flight closed');
    const after = { ...facet.hits };
    await book.tick();
    await book.tick();
    expect(facet.hits).toEqual(after);
  });

  it('follows a translated local route through the gateway hop too', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 64, decoded: 3 } }],
    });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({
      routeId: 'local:own',
      to: 'openai-chat',
    });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('hi'));
    await until(() => book.snapshot()[0]?.phase === 'generating', 'generating via gateway');
    // Подсчёт промпта — только Anthropic ↔ Anthropic: перевод его не просит.
    expect(facet.hits.count).toBe(0);
    stand.stub.release();
    await answer;
    await until(() => book.snapshot()[0]?.inFlight === 0, 'flight closed');
  });

  it('ignores a poll that answers after its request closed', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 64 } }],
    });
    // Ворота на `/slots`: опрос встаёт посреди ответа, пока тест не откроет их.
    const gate: { held?: Promise<void> } = {};
    let open = (): void => undefined;
    let entered = false;
    stand = await hopStand({
      script: { fallback: { text: 'ok', holdMs: Infinity } },
      reply: async (request) => {
        if (gate.held && request.path.startsWith('/slots')) {
          entered = true;
          await gate.held;
        }
        return facet.route(request);
      },
      deps: { now: () => clock.at, activity: { intervalMs: 3_600_000, stallMs: 60_000 } },
    });
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('hi'));
    await until(() => book.snapshot()[0]?.phase === 'prompt', 'first poll');
    expect(book.snapshot()[0]?.lastMoveAt).toBe(1_000);

    gate.held = new Promise((done) => (open = done));
    facet.play([{ health: 'ok', slot: { processing: true, filled: 64, decoded: 9 } }]);
    clock.at = 5_000;
    const late = book.tick();
    await until(() => entered, 'poll held at /slots');
    stand.stub.release();
    await answer;
    await until(() => book.snapshot()[0]?.inFlight === 0, 'flight closed');
    open();
    await late;
    // Поздний ответ не двигает закрытый ход: иначе панель выбрала бы этот маршрут «свежим».
    expect(book.snapshot()[0]).toMatchObject({ phase: 'idle', inFlight: 0, lastMoveAt: 1_000 });
  });

  it('never sends count_tokens on a masked session, still follows the slot', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 32 } }],
      promptTotal: 64,
    });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({
      routeId: 'local:own',
      dlp: { required: true, rulesHash: null },
    });
    const answer = ask(port, placeholder, 'anthropic', anthropicBody('write to a@b.example'));
    await until(() => book.snapshot()[0]?.phase === 'prompt', 'slot followed');
    // Подсчёт ушёл бы наверх немаскированным телом: при маске его нет вовсе.
    expect(facet.hits.count).toBe(0);
    expect(book.snapshot()[0]?.prompt).toEqual({ filled: 32 });
    stand.stub.release();
    await answer;
  });

  it('keeps the long prompt total while a parallel small request starts and ends', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 50 } }],
      // Свой итог у каждого промпта: длинный — 4096, короткий (заголовок, квота) — 100.
      promptTotal: (body) => (JSON.stringify(body).includes('LONG') ? 4096 : 100),
    });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const long = ask(port, placeholder, 'anthropic', anthropicBody('LONG prompt'));
    await until(() => book.snapshot()[0]?.prompt?.total === 4096, 'long total counted');

    // Короткий запрос рядом: его подсчёт не сбрасывает и не подменяет итог длинного.
    const cut = new AbortController();
    const small = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': placeholder,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody('title')),
      signal: cut.signal,
    }).catch(() => undefined);
    await until(() => facet.hits.count === 2 && book.snapshot()[0]?.inFlight === 2, 'small in');
    await new Promise((done) => setTimeout(done, 50));
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ inFlight: 2, prompt: { filled: 50, total: 4096 } });

    cut.abort();
    await small;
    await until(() => book.snapshot()[0]?.inFlight === 1, 'small closed');
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ inFlight: 1, prompt: { filled: 50, total: 4096 } });
    stand.stub.release();
    await long;
  });

  it('never counts a Gemini :countTokens call as a model request', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({ timeline: [{ health: 'ok', slot: { processing: true } }] });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const { port, placeholder } = await stand.register({
      routeId: 'local:own',
      from: 'google-genai',
      to: 'openai-chat',
    });
    // Оценку отвечает само звено: сервер моделей её не видит, и спящий сервер опрос `/slots`
    // разбудил бы загрузкой модели без единого запроса к ней.
    const response = await fetch(`http://127.0.0.1:${port}/v1beta/models/stub-model:countTokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': placeholder },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'one two three' }] }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((done) => setTimeout(done, 100));
    expect(facet.hits).toEqual({ health: 0, slots: 0, count: 0 });
    expect(book.snapshot()).toEqual([]);
  });

  it('drops a count below what the slot already read and skips a non-local route', async () => {
    const clock = { at: 1_000 };
    const facet = llamaSlotsRoute({
      timeline: [{ health: 'ok', slot: { processing: true, filled: 3000 } }],
      promptTotal: 100,
    });
    stand = await start(facet, clock);
    const book = stand.host.ctx.activity;
    if (!book) throw new Error('no activity book');
    const other = await stand.register({ routeId: 'route-stub' });
    const remote = ask(other.port, other.placeholder, 'anthropic', anthropicBody('x'));
    await until(() => stand?.stub.holding() === true, 'remote held');
    expect(book.snapshot()).toEqual([]);
    expect(facet.hits).toEqual({ health: 0, slots: 0, count: 0 });

    const { port, placeholder } = await stand.register({ routeId: 'local:own' });
    const local = ask(port, placeholder, 'anthropic', anthropicBody('y'));
    await until(() => facet.hits.count === 1 && facet.hits.slots >= 1, 'poll + count');
    await book.tick();
    expect(book.snapshot()[0]).toMatchObject({ phase: 'prompt', prompt: { filled: 3000 } });
    expect(book.snapshot()[0]?.prompt?.total).toBeUndefined();
    stand.stub.release();
    await Promise.all([remote, local]);
  });
});
