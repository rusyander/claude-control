/**
 * Сервер заглушки: привязка (loopback, порт 0 / свой, 5170–5180 — отказ), след без
 * значений доступа, формы сценария, шаги-функции над прошлыми телами, удержание и
 * закрытие посреди него, служебные пути. Всё — настоящим HTTP.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  PRESENT,
  RESERVED_PORTS,
  redactHeaders,
  startStubModel,
  type RouteRequest,
  type StubModel,
} from './index.mjs';
import { call } from './clients/call.ts';
import { CLIENTS } from './clients/index.ts';

/** Строка следа / ответ `/models` — только поля, которые читает тест. */
interface TraceLine {
  kind: string;
  path: string;
  headers: Record<string, string>;
  body: { messages: { content: { text: string }[] }[] };
}
interface ModelList {
  data: Record<string, unknown>[];
}

const dir = mkdtempSync(join(tmpdir(), 'stub-model-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: StubModel[] = [];
const start = async (options: Parameters<typeof startStubModel>[0]) => {
  const stub = await startStubModel(options);
  open.push(stub);
  return stub;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((stub) => stub.close()));
});

const post = (stub: StubModel, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${stub.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe('bind', () => {
  it('port 0 → an OS port on 127.0.0.1, baseUrl names it', async () => {
    const stub = await start({});
    expect(stub.port).toBeGreaterThan(0);
    expect(stub.baseUrl).toBe(`http://127.0.0.1:${stub.port}`);
    expect((await fetch(`${stub.baseUrl}/v1/models`)).status).toBe(200);
  });

  it('a caller-chosen port is used as is', async () => {
    const port = await freePort();
    const stub = await start({ port });
    expect(stub.port).toBe(port);
  });

  it.each([RESERVED_PORTS.from, 5178, 5179, RESERVED_PORTS.to])('port %i is refused', (port) => {
    expect(() => startStubModel({ port })).toThrow(RangeError);
  });

  it.each([-1, 70000, 1.5])('port %s is not a TCP port', (port) => {
    expect(() => startStubModel({ port })).toThrow(RangeError);
  });

  it('just outside the reserved range is not refused by the range rule', () => {
    for (const port of [RESERVED_PORTS.from - 1, RESERVED_PORTS.to + 1]) {
      const pending = startStubModel({ port });
      // Порт может быть занят кем-то ещё — это не правило диапазона; закрываем, если поднялся.
      void pending.then((stub) => stub.close()).catch(() => undefined);
    }
  });

  it('unknown option is refused (no host: loopback only)', () => {
    expect(() => startStubModel({ host: '0.0.0.0' } as never)).toThrow(/unknown option «host»/);
  });

  it('is not reachable on a non-loopback interface', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((net) => net && net.family === 'IPv4' && !net.internal)?.address;
    if (!external) return; // машина без внешнего адреса — нечего проверять
    const stub = await start({});
    const result = await new Promise<string>((resolve) => {
      const socket = connect(stub.port, external);
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
    expect(result).not.toBe('connected');
  });

  it('a port in use rejects the start', async () => {
    const first = await start({});
    await expect(startStubModel({ port: first.port })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('trace', () => {
  it('records every request, never a credential value', async () => {
    const trace = join(dir, 'nested', 'trace.jsonl');
    const stub = await start({ trace, script: ['one', 'two'] });
    await call(stub.baseUrl, 'anthropic-messages', { text: 'first ask', stream: true });
    await call(stub.baseUrl, 'openai-chat', { text: 'second ask', stream: false });
    await post(
      stub,
      '/v1/messages/count_tokens',
      { messages: [] },
      { 'x-api-key': 'sk-ant-test-SECRET-VALUE' },
    );
    await fetch(`${stub.baseUrl}/v1/models?key=SECRET-VALUE`, {
      headers: { authorization: 'Bearer SECRET-VALUE' },
    });
    await post(stub, '/v1/unknown', { a: 1 }, { 'api-key': 'SECRET-VALUE' });

    const text = readFileSync(trace, 'utf8');
    expect(text).not.toContain('SECRET-VALUE');
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TraceLine);
    expect(lines.map((line) => line.kind)).toEqual([
      'model',
      'model',
      'utility',
      'models',
      'unknown',
    ]);
    const [first, second, tokens, models, unknown] = lines;
    expect(first).toMatchObject({
      n: 1,
      dialect: 'anthropic-messages',
      stream: true,
      status: 200,
      reply: 'one',
    });
    expect(first!.headers['x-api-key']).toBe(PRESENT);
    expect(first!.headers['anthropic-version']).toBe('2023-06-01');
    expect(first!.body.messages[0]!.content[0]!.text).toBe('first ask');
    expect(first!.path).toBe('/v1/messages?beta=true');
    expect(second).toMatchObject({ n: 2, dialect: 'openai-chat', stream: false, reply: 'two' });
    expect(second!.headers.authorization).toBe(PRESENT);
    expect(tokens).toMatchObject({ dialect: 'anthropic-messages', status: 200 });
    // Метка «есть» — буквально, адрес не пересобирается (F-78).
    expect(models!.path).toBe(`/v1/models?key=${PRESENT}`);
    expect(unknown).toMatchObject({ status: 404, body: { a: 1 } });
    expect(stub.requests.map((r) => r.n)).toEqual([1, 2]);
    expect(stub.requests[0]!.headers['x-api-key']).toBe(PRESENT);
  });

  it('redactHeaders keeps names, hides every credential-like value', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer x',
        'x-api-key': 'k',
        'proxy-authorization': 'p',
        'x-goog-api-key': 'g',
        cookie: 'c',
        'x-auth-token': 't',
        'content-type': 'application/json',
        skipped: undefined,
      }),
    ).toEqual({
      Authorization: PRESENT,
      'x-api-key': PRESENT,
      'proxy-authorization': PRESENT,
      'x-goog-api-key': PRESENT,
      cookie: PRESENT,
      'x-auth-token': PRESENT,
      'content-type': 'application/json',
    });
  });

  it('no trace option → no file, requests still recorded', async () => {
    const stub = await start({});
    await call(stub.baseUrl, 'openai-responses', { text: 'x', stream: true });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.reply).toBe('DONE');
  });
});

describe('utility paths', () => {
  it('GET /models answers both the OpenAI and the Anthropic list shape', async () => {
    const stub = await start({ models: ['a-model', 'b-model'] });
    const body = (await (await fetch(`${stub.baseUrl}/v1/models`)).json()) as ModelList;
    expect(body).toMatchObject({
      object: 'list',
      has_more: false,
      first_id: 'a-model',
      last_id: 'b-model',
    });
    expect(body.data[1]).toMatchObject({
      id: 'b-model',
      object: 'model',
      type: 'model',
      owned_by: 'stub',
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('count_tokens does not spend a script step', async () => {
    const stub = await start({ script: ['only'] });
    const tokens = await post(stub, '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: 'abcdefgh' }],
    });
    expect(((await tokens.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    const outcome = await call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: true });
    expect(outcome.reply).toMatchObject({ parts: [{ kind: 'text', text: 'only' }] });
  });

  it('unknown model path → 404 JSON, no step spent', async () => {
    const stub = await start({ script: ['kept'] });
    const response = await post(stub, '/v1/completions', { prompt: 'x' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /no model route/,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('a non-JSON body still gets a reply and is recorded raw', async () => {
    const stub = await start({});
    const response = await post(stub, '/v1/chat/completions', 'not json');
    expect(response.status).toBe(200);
    expect(stub.requests[0]).toMatchObject({ raw: 'not json', body: {}, stream: false });
  });

  it('chat include_usage → a separate usage chunk with empty choices', async () => {
    const stub = await start({ script: [{ text: 'u', usage: { input: 4, output: 5 } }] });
    const outcome = await call(stub.baseUrl, 'openai-chat', {
      text: 'x',
      stream: true,
      includeUsage: true,
    });
    expect(outcome.text).toMatch(
      /"choices":\[\],"usage":\{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9,"prompt_tokens_details":\{"cached_tokens":0\}\}/,
    );
    expect(outcome.reply).toMatchObject({ usage: { input: 4, output: 5 } });
  });
});

describe('route: the caller own paths before the library', () => {
  it('answers own paths (JSON, text, status, headers) and is traced as route', async () => {
    const trace = join(dir, 'route-trace.jsonl');
    const stub = await start({
      trace,
      route: ({ method, path }) => {
        if (method === 'GET' && path === '/health') return { body: { status: 'ok' } };
        if (path === '/props') return { body: 'plain', headers: { 'x-own': '1' } };
        if (path === '/slots/0') return { status: 501, body: { error: 'no slots' } };
        if (path === '/empty') return {};
        return undefined;
      },
    });
    const health = await fetch(`${stub.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await health.json()).toEqual({ status: 'ok' });
    const props = await post(stub, '/props', {});
    expect(props.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(props.headers.get('x-own')).toBe('1');
    expect(await props.text()).toBe('plain');
    const slots = await post(stub, '/slots/0?action=save', {});
    expect(slots.status).toBe(501);
    expect(await (await fetch(`${stub.baseUrl}/empty`)).json()).toEqual({});
    expect(stub.requests).toHaveLength(0);
    const kinds = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; status: number });
    expect(kinds).toEqual([
      expect.objectContaining({ kind: 'route', status: 200 }),
      expect.objectContaining({ kind: 'route', status: 200 }),
      expect.objectContaining({ kind: 'route', status: 501 }),
      expect.objectContaining({ kind: 'route', status: 200 }),
    ]);
  });

  it('overrides a library utility path (count_tokens) and may be async', async () => {
    const stub = await start({
      script: ['model'],
      route: async ({ path }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return path.endsWith('/count_tokens') ? { body: { input_tokens: 4242 } } : undefined;
      },
    });
    const tokens = await post(stub, '/v1/messages/count_tokens', { messages: [] });
    expect(await tokens.json()).toEqual({ input_tokens: 4242 });
    const outcome = await call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: true });
    expect(outcome.reply).toMatchObject({ parts: [{ kind: 'text', text: 'model' }] });
  });

  it('sees raw headers, the query apart, and no body for a non-JSON payload', async () => {
    const seen: RouteRequest[] = [];
    const stub = await start({
      route: (request) => {
        seen.push(request);
        return undefined;
      },
    });
    await post(stub, '/v1/unknown?x=1', 'not json', { authorization: 'Bearer RAW-VALUE' });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/unknown',
      query: '?x=1',
      raw: 'not json',
      body: undefined,
    });
    expect(seen[0]!.headers.authorization).toBe('Bearer RAW-VALUE');
  });

  it('a throwing route answers 500 naming the error; a non-function route is refused', async () => {
    const stub = await start({
      route: () => {
        throw new Error('route broke');
      },
    });
    const response = await post(stub, '/v1/chat/completions', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: 'stub-model: route broke' } });
    expect(() => startStubModel({ route: 'x' as never })).toThrow(/route must be a function/);
  });

  it('a route stream is written by the package frames; a client gone mid-delay stops it', async () => {
    const stub = await start({
      route: ({ path }) => {
        if (path === '/bad') return { sse: { frames: 'x' as never } };
        return {
          headers: { 'x-own': '1' },
          sse: {
            delayMs: path === '/slow' ? 60_000 : 0,
            frames: [{ event: 'ping', data: { a: 1 } }, { data: '[DONE]' }],
          },
        };
      },
    });
    const response = await fetch(`${stub.baseUrl}/v1/own`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-own')).toBe('1');
    expect(await response.text()).toBe('event: ping\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    const aborter = new AbortController();
    const slow = await fetch(`${stub.baseUrl}/slow`, { signal: aborter.signal });
    expect(stub.holding()).toBe(false);
    aborter.abort();
    await expect(slow.text()).rejects.toThrow();
    expect((await fetch(`${stub.baseUrl}/bad`)).status).toBe(500);
  });
});

describe('request inspection per dialect', () => {
  it.each(Object.keys(CLIENTS) as (keyof typeof CLIENTS)[])(
    '%s: user texts, tool names, tool result',
    async (dialect) => {
      const stub = await start({});
      await call(stub.baseUrl, dialect, { text: 'ask one', stream: true, tool: true });
      await call(stub.baseUrl, dialect, { text: 'ask two', stream: true, toolResult: true });
      const [plain, withResult] = stub.requests;
      expect(plain).toMatchObject({ dialect, userTexts: ['ask one'], hasToolResult: false });
      expect(plain!.tools[0]).toMatch(/^(Bash|shell)$/);
      expect(withResult!.hasToolResult).toBe(true);
      expect(withResult!.userTexts[0]).toBe('ask two');
    },
  );

  it('responses: a string input is one user text; custom tools are marked', async () => {
    const stub = await start({
      script: (ctx) => ({ text: JSON.stringify(ctx.info.tools) }),
    });
    const response = await post(stub, '/v1/responses', {
      model: 'm',
      input: 'plain string',
      tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'web_search' }],
    });
    expect(response.status).toBe(200);
    expect(stub.requests[0]!.userTexts).toEqual(['plain string']);
    expect(stub.requests[0]!.tools).toEqual(['apply_patch', 'web_search']);
    expect(stub.requests[0]!.reply).toContain('"custom":true');
  });
});

describe('script', () => {
  it('array steps run in order, then the fallback', async () => {
    const stub = await start({
      script: { steps: ['a', { text: 'b' }], fallback: { text: 'END' } },
    });
    const replies = [];
    for (let i = 0; i < 3; i += 1)
      replies.push((await call(stub.baseUrl, 'openai-chat', { text: 'x', stream: true })).reply);
    expect(replies.map((r) => (r as { parts: { text: string }[] }).parts[0]!.text)).toEqual([
      'a',
      'b',
      'END',
    ]);
  });

  it('rules by marker (string, RegExp, function) win over steps; times limits a rule', async () => {
    const stub = await start({
      script: {
        rules: [
          { when: 'MARK-1', step: { text: 'saw mark' }, times: 1 },
          { when: /REGEX-\d+/, step: (ctx) => ({ text: `regex at ${ctx.index}` }) },
          { when: (ctx) => ctx.info.hasToolResult, step: { text: 'tool result seen' } },
        ],
        steps: ['plain'],
      },
    });
    const text = async (ask: string, toolResult = false) =>
      (
        (await call(stub.baseUrl, 'openai-responses', { text: ask, stream: true, toolResult }))
          .reply as {
          parts: { text: string }[];
        }
      ).parts[0]!.text;
    expect(await text('has MARK-1')).toBe('saw mark');
    expect(await text('has MARK-1 again')).toBe('plain');
    expect(await text('REGEX-42 here')).toBe('regex at 2');
    expect(await text('q', true)).toBe('tool result seen');
    expect(await text('nothing')).toBe('DONE');
  });

  it('function steps are computed from past request bodies', async () => {
    const stub = await start({
      script: (ctx) => {
        if (ctx.index === 0) return { tool: { name: 'shell', args: { command: 'echo RUN-77' } } };
        const previous = JSON.parse(ctx.bodies[ctx.index - 1]!) as {
          messages: { content: string }[];
        };
        return {
          text: `prev asked: ${previous.messages[1]!.content}; count ${ctx.requests.length}`,
        };
      },
    });
    const first = await call(stub.baseUrl, 'openai-chat', { text: 'go', stream: true, tool: true });
    expect(first.reply).toMatchObject({
      parts: [{ kind: 'tool', name: 'shell', args: { command: 'echo RUN-77' } }],
    });
    const second = await call(stub.baseUrl, 'openai-chat', { text: 'next', stream: true });
    expect(second.reply).toMatchObject({ parts: [{ text: 'prev asked: go; count 2' }] });
    expect(stub.bodies).toHaveLength(2);
    expect(stub.requests[0]!.reply).toBe('tool:shell');
  });

  it('async step functions may wait before answering', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stub = await start({ script: async () => (await gate, 'released') });
    const pending = call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: true });
    setTimeout(release, 50);
    expect((await pending).reply).toMatchObject({ parts: [{ text: 'released' }] });
  });

  it('a throwing script or a malformed step answers STUB SCRIPT FAILED and records why', async () => {
    const steps: unknown[] = [
      () => {
        throw new Error('boom');
      },
      { wat: 1 },
      { text: 5 },
      { error: { status: 200 } },
      { error: { status: 429 }, text: 'both' },
      { tool: { args: {} } },
      { custom: { name: 'x' } },
      { text: 'ok', holdMs: -1 },
      { error: { status: 429, retryAfter: 'soon' } },
      {},
      42,
    ];
    const stub = await start({
      script: (ctx) => {
        const step = steps[ctx.index];
        return (typeof step === 'function' ? step() : step) as never;
      },
    });
    for (let i = 0; i < steps.length; i += 1) {
      const outcome = await call(stub.baseUrl, 'openai-chat', { text: 'x', stream: true });
      expect((outcome.reply as { parts: { text: string }[] }).parts[0]!.text).toMatch(
        /^STUB SCRIPT FAILED: /,
      );
    }
    expect(stub.requests.map((r) => r.scriptError)).toEqual([
      'boom',
      expect.stringMatching(/unknown step key «wat»/),
      expect.stringMatching(/step.text must be a string/),
      expect.stringMatching(/HTTP error status/),
      expect.stringMatching(/carries no reply parts/),
      expect.stringMatching(/step.tool.name is required/),
      expect.stringMatching(/custom needs a name/),
      expect.stringMatching(/holdMs must be a number/),
      expect.stringMatching(/retryAfter must be a number/),
      expect.stringMatching(/needs text, tool, tools, custom or error/),
      expect.stringMatching(/a step must be an object/),
    ]);
  });

  it('malformed text chunks and extra fields answer STUB SCRIPT FAILED', async () => {
    const steps: unknown[] = [
      { text: [] },
      { text: ['a', 1] },
      { text: 'ok', extra: [] },
      { text: 'ok', extra: 'x' },
    ];
    const stub = await start({ script: (ctx) => steps[ctx.index] as never });
    for (let i = 0; i < steps.length; i += 1)
      await call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: true });
    expect(stub.requests.map((r) => r.scriptError)).toEqual([
      expect.stringMatching(/non-empty string array/),
      expect.stringMatching(/non-empty string array/),
      expect.stringMatching(/step.extra must be an object/),
      expect.stringMatching(/step.extra must be an object/),
    ]);
  });

  it('a malformed script is refused at start, not on a request', () => {
    expect(() => startStubModel({ script: 5 as never })).toThrow(/script must be/);
    expect(() => startStubModel({ script: { stepz: [] } as never })).toThrow(
      /unknown script key «stepz»/,
    );
    expect(() => startStubModel({ script: { steps: 'x' } as never })).toThrow(/steps must be/);
    expect(() => startStubModel({ script: { rules: [{ when: 1, step: 'x' }] } as never })).toThrow(
      /when must be/,
    );
    expect(() => startStubModel({ script: { rules: [{ when: 'x' }] } as never })).toThrow(
      /step is missing/,
    );
  });

  it('step.model answers with another model id than asked, in every dialect, stream and JSON (P119 substitution)', async () => {
    const stub = await start({ script: () => ({ text: 'ok', model: 'served-other' }) });
    for (const dialect of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const)
      for (const stream of [true, false]) {
        const outcome = await call(stub.baseUrl, dialect, { text: 'x', stream });
        expect(outcome.status).toBe(200);
        expect(outcome.text).toContain('"served-other"');
        expect(outcome.text).not.toContain('"claude-test"');
        expect(outcome.text).not.toContain('"gpt-test"');
      }
    // Запрос назвал свою модель — след хранит запрошенную, ответ несёт подменённую.
    expect(stub.requests.map((r) => r.model)).not.toContain('served-other');
    const bad = await start({ script: () => ({ text: 'ok', model: 5 }) as never });
    await call(bad.baseUrl, 'anthropic-messages', { text: 'x', stream: true });
    expect(bad.requests[0]?.scriptError).toMatch(/step.model/);
  });

  it('a mid-stream error asked without stream falls back to the HTTP status', async () => {
    const stub = await start({
      script: [{ error: { status: 503, midStream: true, type: 'own_type', code: 'own_code' } }],
    });
    const outcome = await call(stub.baseUrl, 'openai-responses', { text: 'x', stream: false });
    expect(outcome.status).toBe(503);
    // Конверт OpenAI: тип — `type`, свой код — рядом в `code`.
    expect(outcome.reply).toMatchObject({ kind: 'error', type: 'own_type' });
    expect(JSON.parse(outcome.text)).toMatchObject({ error: { code: 'own_code' } });
    expect(stub.requests[0]).toMatchObject({ status: 503, reply: 'error:503:mid-stream' });
  });

  it('own headers ride on the reply; window maps seven_day to the 7d headers', async () => {
    const stub = await start({
      script: [
        { text: 'h', headers: { 'x-own': '1' }, window: { utilization: 1, claim: 'seven_day' } },
      ],
    });
    const outcome = await call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: false });
    expect(outcome.headers.get('x-own')).toBe('1');
    expect(outcome.headers.get('anthropic-ratelimit-unified-7d-utilization')).toBe('1');
    expect(outcome.headers.get('anthropic-ratelimit-unified-status')).toBe('rejected');
  });
});

describe('hold and close', () => {
  it('holding() is true only while a hold runs', async () => {
    const stub = await start({ script: [{ text: 'held', holdMs: 300 }] });
    expect(stub.holding()).toBe(false);
    const pending = call(stub.baseUrl, 'openai-chat', { text: 'x', stream: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.holding()).toBe(true);
    await pending;
    expect(stub.holding()).toBe(false);
  });

  it('close() mid-hold returns at once and cuts the client', async () => {
    const stub = await startStubModel({ script: [{ text: 'never', holdMs: 60_000 }] });
    const pending = call(stub.baseUrl, 'openai-chat', { text: 'x', stream: true }).then(
      () => 'answered',
      () => 'cut',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = performance.now();
    await stub.close();
    expect(performance.now() - before).toBeLessThan(2000);
    expect(await pending).toBe('cut');
    expect(stub.holding()).toBe(false);
    // Обрыв закрытием заглушки — не уход клиента: пометки нет.
    expect(stub.requests[0]!.aborted).toBeUndefined();
  });

  it('release() with nothing held is a no-op; the next hold still runs in full', async () => {
    const stub = await start({ script: [{ text: 'held', holdMs: 300 }] });
    stub.release();
    const outcome = await call(stub.baseUrl, 'openai-chat', { text: 'x', stream: false });
    expect(outcome.firstByteMs).toBeGreaterThanOrEqual(280);
  });

  it('a client that leaves mid-stall ends the hold', async () => {
    const stub = await start({ script: [{ text: 'never', stallMs: 60_000 }] });
    const abort = new AbortController();
    const response = await fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CLIENTS['openai-chat'].request({ text: 'x', stream: true })),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(stub.holding()).toBe(true);
    abort.abort();
    for (let i = 0; i < 40 && stub.holding(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stub.holding()).toBe(false);
  });
});
