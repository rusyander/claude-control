import { afterAll, describe, expect, it } from 'vitest';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { allocatePort } from '../../../platform/ports.ts';
import { startLocalFront, type LocalFront, type LocalFrontOptions } from './front.ts';
import type { HoldServed } from './hold.ts';
import { createSlotCache } from '../../../platform/slot-cache.ts';

/**
 * Окно модели на постоянном адресе (этап 10, зона C4): за адресом — настоящая заглушка модели
 * (`packages/stub-model`), запросы идут через настоящий HTTP. Удержание подменено целью, которая
 * сразу называет заглушку: окно судит по `context` цели, не по серверу.
 */

const CONTEXT = 8_192;
const MODEL = 'tiny-model';
const stubs: StubModel[] = [];
const fronts: LocalFront[] = [];

afterAll(async () => {
  await Promise.all(fronts.map((front) => front.stop()));
  await Promise.all(stubs.map((stub) => stub.close()));
});

interface Kit {
  stub: StubModel;
  front: LocalFront;
  routed: RouteRequest[];
}

async function kit(
  stubOptions: Parameters<typeof startStubModel>[0] = {},
  frontOptions: Partial<LocalFrontOptions> = {},
  served: Partial<HoldServed> = {},
): Promise<Kit> {
  const routed: RouteRequest[] = [];
  const own = stubOptions.route;
  const stub = await startStubModel({
    models: [MODEL],
    ...stubOptions,
    route: async (request) => {
      if (request.path.startsWith('/slots') || request.path.endsWith('/count_tokens'))
        routed.push(request);
      return own ? own(request) : undefined;
    },
  });
  stubs.push(stub);
  const front = startLocalFront({
    port: (await allocatePort()).port,
    target: async () => ({
      origin: stub.baseUrl.replace(/\/$/, ''),
      model: MODEL,
      context: CONTEXT,
      shape: 'shape-1',
      ...served,
    }),
    retryMs: 50,
    ...frontOptions,
  });
  fronts.push(front);
  for (let i = 0; i < 100 && !front.listening(); i += 1)
    await new Promise((done) => setTimeout(done, 20));
  return { stub, front, routed };
}

async function post(
  front: LocalFront,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${front.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

/** Тело ~`chars` символов: оценка окна — символы / 3. */
const filler = (chars: number): string => 'x'.repeat(chars);

const anthropic = (content: string, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: 'user', content }],
  ...extra,
});
const openai = (content: string, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [{ role: 'user', content }],
  ...extra,
});

describe('local front — the model window on the stable address', () => {
  it('Anthropic: a prompt over the window → 400 «prompt is too long» counted by the server, nothing reaches the model', async () => {
    const k = await kit({
      route: (request) =>
        request.path.endsWith('/count_tokens')
          ? { status: 200, body: { input_tokens: 9_000 } }
          : undefined,
    });
    const reply = await post(k.front, '/v1/messages', anthropic(filler(14_000)));
    expect(reply.status).toBe(400);
    expect(reply.json).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 9000 tokens > 4096 maximum',
      },
    });
    expect(k.routed.map((r) => r.path)).toEqual(['/v1/messages/count_tokens']);
    expect(k.stub.requests).toEqual([]);
  });

  it('OpenAI: a prompt over the window → 400 context_length_exceeded in the OpenAI shape, nothing reaches the model', async () => {
    const k = await kit();
    const reply = await post(k.front, '/v1/chat/completions', openai(filler(14_000)));
    expect(reply.status).toBe(400);
    const error = reply.json.error as Record<string, unknown>;
    expect(error.code).toBe('context_length_exceeded');
    expect(error.type).toBe('invalid_request_error');
    expect(String(error.message)).toMatch(/^prompt is too long: \d+ tokens > 4096 maximum$/);
    expect(k.stub.requests).toEqual([]);
  });

  it('OpenAI: max_tokens over what is left of the window is clamped in the request the model receives', async () => {
    const k = await kit({ script: [{ text: 'clamped' }] });
    const body = openai('hello', { max_tokens: 100_000 });
    const reply = await post(k.front, '/v1/chat/completions', body);
    expect(reply.status).toBe(200);
    const sent = k.stub.requests[0]?.body ?? {};
    const prompt = Math.ceil(JSON.stringify(body).length / 3);
    expect(sent.max_tokens).toBe(CONTEXT - prompt - 512);
    expect(sent.messages).toEqual(body.messages);
  });

  it('OpenAI: max_tokens that fits is passed untouched', async () => {
    const k = await kit({ script: [{ text: 'as is' }] });
    const reply = await post(k.front, '/v1/chat/completions', openai('hello', { max_tokens: 300 }));
    expect(reply.status).toBe(200);
    expect(k.stub.requests[0]?.body.max_tokens).toBe(300);
  });

  it('Anthropic: input fits but input + max_tokens does not → 400 with the text Claude Code reduces max_tokens by', async () => {
    const k = await kit();
    const body = anthropic(filler(6_000), { max_tokens: 8_000 });
    const reply = await post(k.front, '/v1/messages', body);
    expect(reply.status).toBe(400);
    const prompt = Math.ceil(JSON.stringify(body).length / 3);
    expect((reply.json.error as Record<string, unknown>).message).toBe(
      `input length and \`max_tokens\` exceed context limit: ${prompt} + 8000 > ${CONTEXT}`,
    );
    expect(k.stub.requests).toEqual([]);
  });

  it('the model server’s own «exceeds the available context size» 400 is turned into the refusal the client recognises', async () => {
    const k = await kit({
      script: [
        {
          error: {
            status: 400,
            message: 'request (9100 tokens) exceeds the available context size (8192 tokens)',
          },
        },
      ],
    });
    const reply = await post(k.front, '/v1/chat/completions', openai('hello'));
    expect(reply.status).toBe(400);
    const error = reply.json.error as Record<string, unknown>;
    expect(error.message).toBe('prompt is too long: 9100 tokens > 4096 maximum');
    expect(error.code).toBe('context_length_exceeded');
  });

  it('first byte: a server silent past the deadline → 504 local_first_byte_timeout; the deadline grows with the prompt', async () => {
    const k = await kit(
      {
        script: [
          { text: 'late', holdMs: 5_000 },
          { text: 'slow but in time', holdMs: 900 },
        ],
      },
      { firstByteFloorMs: 300 },
    );
    const started = Date.now();
    const late = await post(k.front, '/v1/messages', anthropic('hi'));
    expect(late.status).toBe(504);
    expect((late.json.error as Record<string, unknown>).type).toBe('local_first_byte_timeout');
    expect(Date.now() - started).toBeLessThan(4_000);
    const slow = await kit(
      { script: [{ text: 'slow but in time', holdMs: 900 }] },
      { firstByteFloorMs: 300 },
      // 1 токен/с: промпт ~40 токенов → срок ~60 с, а не 0,3 с — ответ через 0,9 с успевает.
      { promptTokensPerSecond: 1 },
    );
    const inTime = await post(slow.front, '/v1/messages', anthropic('hi'));
    expect(inTime.status).toBe(200);
  });

  it('a model name the router renamed (`qwen3.8:27b` → `qwen3.8:27B`): body, `?model=` and slot actions carry the router’s name', async () => {
    const asked: string[] = [];
    const k = await kit(
      {
        models: ['qwen3.8:27B'],
        script: [{ text: 'renamed' }],
        route: (request) => {
          if (request.path === '/props') {
            asked.push(request.query);
            return { status: 200, body: { ok: true } };
          }
          return request.path.startsWith('/slots')
            ? { status: 200, body: { n_erased: 0 } }
            : undefined;
        },
      },
      { slots: createSlotCache() },
      { model: 'qwen3.8:27b' },
    );
    const reply = await post(k.front, '/v1/messages', {
      ...anthropic('hello', {
        metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 's1' }) },
      }),
      model: 'qwen3.8:27b',
    });
    expect(reply.status).toBe(200);
    expect(k.stub.requests[0]?.body.model).toBe('qwen3.8:27B');
    // Обратно клиент получает СВОЁ имя: учёт трат и каталог считают модель по нему.
    expect(reply.json.model).toBe('qwen3.8:27b');
    expect(k.routed.map((r) => `${r.path}${r.query}`)).toEqual([
      '/slots/0?action=erase&model=qwen3.8%3A27B',
    ]);
    const props = await fetch(`${k.front.url}/props?model=qwen3.8:27b`);
    expect(props.status).toBe(200);
    expect(asked).toEqual(['?model=qwen3.8%3A27B']);
  });

  it('the router’s name never leaves the front: streams and bodies of both dialects carry the name the client asked for', async () => {
    const k = await kit(
      {
        models: ['qwen3.8:27B'],
        script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      },
      {},
      { model: 'qwen3.8:27b' },
    );
    const stream = async (path: string, body: Record<string, unknown>): Promise<string> => {
      const response = await fetch(`${k.front.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'local' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      return response.text();
    };
    /** Имена модели из кадров `data:` потока: верхний `model` и `message.model` (Anthropic). */
    const namesOf = (sse: string): string[] =>
      sse
        .split('\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
        .flatMap((frame) => [frame.model, (frame.message as Record<string, unknown>)?.model])
        .filter((name): name is string => typeof name === 'string');

    const anthropicSse = await stream(
      '/v1/messages',
      anthropic('hi', { model: 'qwen3.8:27b', stream: true }),
    );
    expect(anthropicSse).toContain('event: message_start');
    expect(namesOf(anthropicSse)).toEqual(['qwen3.8:27b']);
    expect(anthropicSse).not.toContain('27B');

    const openaiSse = await stream(
      '/v1/chat/completions',
      openai('hi', { model: 'qwen3.8:27b', stream: true }),
    );
    const openaiNames = namesOf(openaiSse);
    expect(openaiNames.length).toBeGreaterThan(1);
    expect(new Set(openaiNames)).toEqual(new Set(['qwen3.8:27b']));
    expect(openaiSse).not.toContain('27B');

    const plain = await post(
      k.front,
      '/v1/chat/completions',
      openai('hi', { model: 'qwen3.8:27b' }),
    );
    expect(plain.status).toBe(200);
    expect(plain.json.model).toBe('qwen3.8:27b');
    expect(JSON.stringify(plain.json)).not.toContain('27B');
    expect(k.stub.requests.map((r) => r.body.model)).toEqual([
      'qwen3.8:27B',
      'qwen3.8:27B',
      'qwen3.8:27B',
    ]);
  });

  it('prepare(session): a new conversation erases the slot, the same one keeps it, a request without a session leaves it', async () => {
    const k = await kit(
      {
        script: [{ text: 'a1' }, { text: 'a2' }, { text: 'b1' }, { text: 'probe' }],
        route: (request) =>
          request.path.startsWith('/slots') ? { status: 200, body: { n_erased: 10 } } : undefined,
      },
      { slots: createSlotCache() },
    );
    const as = (session: string) => ({
      metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: session }) },
    });
    const slotCalls = () =>
      k.routed.filter((r) => r.path.startsWith('/slots')).map((r) => `${r.path}${r.query}`);
    await post(k.front, '/v1/messages', anthropic('one', as('chat-a')));
    expect(slotCalls()).toEqual([`/slots/0?action=erase&model=${MODEL}`]);
    await post(k.front, '/v1/messages', anthropic('two', as('chat-a')));
    expect(slotCalls()).toHaveLength(1);
    await post(k.front, '/v1/messages', anthropic('three', as('chat-b')));
    expect(slotCalls()).toHaveLength(2);
    await post(k.front, '/v1/messages', anthropic('probe'));
    expect(slotCalls()).toHaveLength(2);
    expect(k.stub.requests).toHaveLength(4);
  });
});
