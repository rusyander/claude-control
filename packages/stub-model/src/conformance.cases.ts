/**
 * ОДИН набор случаев на все протоколы (P121): каждая возможность из `STUB_CAPS`
 * получает здесь случай на каждом протоколе, где она заявлена; тест покрытия
 * возможностей (`caps.test.ts`) краснеет на заявленной возможности без случая.
 * Ответ разбирает клиент-оракул протокола (`clients/`), а не код пакета.
 */
import { expect } from 'vitest';
import type { DialectId, RouteRequest, Step, StubModel } from './index.d.mts';
import type { Reply, RequestOptions } from './clients/index.ts';
import { dataJson, parseSse } from './clients/sse.ts';

export interface Outcome {
  status: number;
  headers: Headers;
  reply: Reply;
  /** Мс до первого байта тела и до конца ответа. */
  firstByteMs: number;
  totalMs: number;
  /** Тело как пришло — для счёта кадров и полей сверх формы ответа. */
  text: string;
}

/** Что набор видит рядом с ответом: заглушку и всё, что видел её наблюдатель `route`. */
export interface Harness {
  stub: StubModel;
  routed: RouteRequest[];
}

export interface Case {
  cap: string;
  name: string;
  request: RequestOptions;
  step: Step;
  /** Идёт вместе с запросом: отпустить удержание, оборвать запрос клиентом. */
  during?(harness: Harness, abort: () => void): Promise<void>;
  check(outcome: Outcome, dialect: DialectId, harness: Harness): void;
}

/**
 * Возможности, добавленные под проверки `tools/qa` (P120): идут своим блоком
 * `extended caps`, чтобы у них был свой кейс в блоке тестов рядом с базовыми.
 */
export const EXTENDED_CAPS: ReadonlySet<string> = new Set([
  'chunkedText',
  'cachedUsage',
  'extraFields',
  'release',
  'aborted',
  'routes',
]);

/** Ждать условия на заглушке (удержание началось, запись помечена) — не дольше 3 с. */
export async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Дельты текста в сыром потоке — по форме протокола, не по коду пакета. */
function textDeltas(dialect: DialectId, text: string): string[] {
  const events = parseSse(text).filter((event) => event.data !== '[DONE]');
  if (dialect === 'anthropic-messages')
    return events
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => dataJson(event).delta as Record<string, unknown>)
      .filter((delta) => delta.type === 'text_delta')
      .map((delta) => String(delta.text));
  if (dialect === 'openai-responses')
    return events
      .filter((event) => event.event === 'response.output_text.delta')
      .map((event) => String(dataJson(event).delta));
  return events
    .map((event) => (dataJson(event).choices as Record<string, unknown>[] | undefined)?.[0])
    .map((choice) => (choice?.delta as Record<string, unknown> | undefined)?.content)
    .filter((content): content is string => typeof content === 'string' && content !== '');
}

/** Итоговый объект ответа, куда протокол кладёт поля сверх формы (как `timings` llama-server). */
function finalObject(dialect: DialectId, text: string, stream: boolean): Record<string, unknown> {
  if (!stream) return JSON.parse(text) as Record<string, unknown>;
  const events = parseSse(text).filter((event) => event.data !== '[DONE]');
  if (dialect === 'anthropic-messages')
    return dataJson(events.find((event) => event.event === 'message_delta')!);
  if (dialect === 'openai-responses')
    return dataJson(events.find((event) => event.event === 'response.completed')!)
      .response as Record<string, unknown>;
  return dataJson(events.at(-1)!);
}

const ASK = { text: 'hello stub' };

const message = (outcome: Outcome) => {
  expect(outcome.reply.kind).toBe('message');
  return outcome.reply as Extract<Reply, { kind: 'message' }>;
};

const STOP: Record<DialectId, { text: string; tool: string }> = {
  'anthropic-messages': { text: 'end_turn', tool: 'tool_use' },
  'openai-chat': { text: 'stop', tool: 'tool_calls' },
  'openai-responses': { text: 'completed', tool: 'completed' },
};

const textCase = (cap: string, stream: boolean): Case => ({
  cap,
  name: `text reply, ${stream ? 'SSE' : 'JSON'}`,
  request: { ...ASK, stream },
  step: { text: 'Привет, stub', usage: { input: 7, output: 3 } },
  check(outcome, dialect) {
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get('content-type')).toMatch(
      stream ? /^text\/event-stream/ : /^application\/json/,
    );
    const reply = message(outcome);
    expect(reply.parts).toEqual([{ kind: 'text', text: 'Привет, stub' }]);
    expect(reply.stopReason).toBe(STOP[dialect].text);
    expect(reply.usage).toEqual({ input: 7, output: 3 });
  },
});

const toolCase = (stream: boolean): Case => ({
  cap: 'tools',
  name: `text + two tool calls, ${stream ? 'SSE' : 'JSON'}`,
  request: { ...ASK, stream, tool: true },
  step: {
    text: 'running',
    tools: [
      { name: 'shell', args: { command: 'echo один' } },
      { name: 'shell', args: { command: 'echo два' }, id: 'call_custom' },
    ],
  },
  check(outcome, dialect) {
    const reply = message(outcome);
    expect(reply.stopReason).toBe(STOP[dialect].tool);
    expect(reply.parts.map((part) => part.kind)).toEqual(['text', 'tool', 'tool']);
    const [, first, second] = reply.parts;
    expect(first).toMatchObject({ name: 'shell', args: { command: 'echo один' } });
    expect(second).toMatchObject({
      name: 'shell',
      args: { command: 'echo два' },
      id: 'call_custom',
    });
    expect((first as { id: string }).id).not.toBe((second as { id: string }).id);
  },
});

const errorCase = (status: number, retryAfter?: number): Case => ({
  cap: `error:${status}`,
  name: `HTTP ${status}${retryAfter !== undefined ? ' + retry-after' : ''}`,
  request: { ...ASK, stream: true },
  step: {
    error: {
      status,
      message: `scripted ${status}`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  },
  check(outcome) {
    expect(outcome.status).toBe(status);
    expect(outcome.headers.get('content-type')).toMatch(/^application\/json/);
    expect(outcome.reply).toMatchObject({
      kind: 'error',
      midStream: false,
      message: `scripted ${status}`,
    });
    // Тип без поля в теле оракул отвергает сам (F-77); здесь — что он из протокольного словаря.
    expect((outcome.reply as { type: string }).type).toMatch(/^[a-z][a-z_]*$/);
    expect(outcome.headers.get('retry-after')).toBe(
      retryAfter === undefined ? null : String(retryAfter),
    );
  },
});

export function casesFor(dialect: DialectId): Case[] {
  const cases: Case[] = [
    textCase('streaming', true),
    textCase('nonStreaming', false),
    toolCase(true),
    toolCase(false),
    errorCase(402),
    errorCase(429, 7),
    errorCase(451),
    errorCase(503),
    {
      cap: 'midStreamErrors',
      name: 'error after the stream started',
      request: { ...ASK, stream: true },
      step: { error: { status: 529, message: 'overloaded mid-stream', midStream: true } },
      check(outcome) {
        expect(outcome.status).toBe(200);
        expect(outcome.reply).toMatchObject({
          kind: 'error',
          midStream: true,
          type: expect.stringMatching(/^[a-z][a-z_]*$/),
          message: 'overloaded mid-stream',
        });
      },
    },
    {
      cap: 'window',
      name: 'window / rate-limit headers',
      request: { ...ASK, stream: true },
      step: {
        text: 'ok',
        window: { utilization: 0.9, resetsAt: 4_102_444_800, status: 'allowed_warning' },
      },
      check(outcome, d) {
        message(outcome);
        if (d === 'anthropic-messages') {
          expect(outcome.headers.get('anthropic-ratelimit-unified-status')).toBe('allowed_warning');
          expect(outcome.headers.get('anthropic-ratelimit-unified-reset')).toBe('4102444800');
          expect(outcome.headers.get('anthropic-ratelimit-unified-5h-utilization')).toBe('0.9');
          expect(outcome.headers.get('anthropic-ratelimit-unified-representative-claim')).toBe(
            'five_hour',
          );
        } else {
          expect(outcome.headers.get('x-ratelimit-remaining-requests')).toBe('10');
          expect(outcome.headers.get('x-ratelimit-limit-requests')).toBe('100');
          expect(outcome.headers.get('x-ratelimit-reset-requests')).toMatch(/^\d+s$/);
        }
      },
    },
    {
      cap: 'hold',
      name: 'hold before the first byte',
      request: { ...ASK, stream: true },
      step: { text: 'late', holdMs: 400 },
      check(outcome) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'late' }]);
        expect(outcome.firstByteMs).toBeGreaterThanOrEqual(380);
      },
    },
    {
      cap: 'stall',
      name: 'stall after the stream head',
      request: { ...ASK, stream: true },
      step: { text: 'after stall', stallMs: 400 },
      check(outcome) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'after stall' }]);
        expect(outcome.firstByteMs).toBeLessThan(300);
        expect(outcome.totalMs).toBeGreaterThanOrEqual(380);
      },
    },
    ...[true, false].map((stream): Case => ({
      cap: 'chunkedText',
      name: `text as chunks, ${stream ? 'SSE: one delta per chunk' : 'JSON: joined'}`,
      request: { ...ASK, stream },
      step: { text: ['При', 'вет, ', 'stub'] },
      check(outcome, d) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'Привет, stub' }]);
        if (stream) expect(textDeltas(d, outcome.text)).toEqual(['При', 'вет, ', 'stub']);
      },
    })),
    ...[true, false].map((stream): Case => ({
      cap: 'cachedUsage',
      name: `cached input tokens in the protocol's cache field, ${stream ? 'SSE' : 'JSON'}`,
      request: { ...ASK, stream },
      step: { text: 'ok', usage: { input: 12, output: 2, cached: 5 } },
      check(outcome) {
        expect(message(outcome).usage).toEqual({ input: 12, output: 2, cached: 5 });
      },
    })),
    ...[true, false].map((stream): Case => ({
      cap: 'extraFields',
      name: `extra fields on the final reply object, ${stream ? 'SSE' : 'JSON'}`,
      request: { ...ASK, stream },
      step: { text: 'ok', extra: { timings: { predicted_n: 2, prompt_n: 12 } } },
      check(outcome, d) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'ok' }]);
        expect(finalObject(d, outcome.text, stream).timings).toEqual({
          predicted_n: 2,
          prompt_n: 12,
        });
      },
    })),
    {
      cap: 'release',
      name: 'release() ends a long hold at once',
      request: { ...ASK, stream: true },
      step: { text: 'released', holdMs: 60_000 },
      async during({ stub }) {
        await until(() => stub.holding(), 'the hold');
        stub.release();
      },
      check(outcome, _d, { stub }) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'released' }]);
        expect(outcome.totalMs).toBeLessThan(5000);
        expect(stub.holding()).toBe(false);
        expect(stub.requests.at(-1)?.aborted).toBeUndefined();
      },
    },
    ...(['holdMs', 'stallMs'] as const).map((delay): Case => ({
      cap: 'aborted',
      name: `client leaves during ${delay === 'holdMs' ? 'hold' : 'stall'} → requests[].aborted`,
      request: { ...ASK, stream: true },
      step: { text: 'never sent', [delay]: 60_000 },
      async during({ stub }, abort) {
        await until(() => stub.holding(), 'the delay');
        abort();
        await until(() => stub.requests.at(-1)?.aborted === true, 'the aborted mark');
      },
      check(outcome, _d, { stub }) {
        expect(outcome.reply).toMatchObject({ kind: 'error', type: 'aborted' });
        expect(outcome.totalMs).toBeLessThan(5000);
        expect(stub.requests.at(-1)?.aborted).toBe(true);
        expect(stub.holding()).toBe(false);
      },
    })),
    {
      cap: 'routes',
      name: 'route observer sees the model request first, reply still from the dialect',
      request: { text: 'observed by route', stream: true },
      step: { text: 'dialect reply' },
      check(outcome, _d, { stub, routed }) {
        expect(message(outcome).parts).toEqual([{ kind: 'text', text: 'dialect reply' }]);
        const seen = routed.at(-1)!;
        const [path, query = ''] = stub.requests.at(-1)!.path.split('?');
        expect(seen).toMatchObject({ method: 'POST', path, query: query && `?${query}` });
        expect(seen.raw).toContain('observed by route');
        expect(seen.body).toEqual(stub.requests.at(-1)!.body);
      },
    },
  ];
  if (dialect === 'openai-chat')
    cases.push({
      cap: 'streaming',
      name: 'include_usage → usage in its own chunk with empty choices, after finish_reason',
      request: { ...ASK, stream: true, includeUsage: true },
      step: { text: 'counted', usage: { input: 4, output: 1 } },
      check(outcome) {
        expect(message(outcome).usage).toEqual({ input: 4, output: 1 });
        const chunks = parseSse(outcome.text)
          .filter((event) => event.data !== '[DONE]')
          .map((event) => dataJson(event));
        const last = chunks.at(-1)!;
        expect(last.choices).toEqual([]);
        expect(last.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 1 });
        // Справка OpenAI: при include_usage прочие чанки несут `usage: null` или без поля.
        expect(chunks.slice(0, -1).filter((one) => one.usage)).toEqual([]);
      },
    });
  if (dialect === 'openai-responses')
    for (const stream of [true, false])
      cases.push({
        cap: 'customTools',
        name: `custom tool call (apply_patch), ${stream ? 'SSE' : 'JSON'}`,
        request: { ...ASK, stream, tool: true },
        step: { custom: { name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' } },
        check(outcome) {
          expect(message(outcome).parts).toEqual([
            {
              kind: 'custom',
              id: expect.stringMatching(/\w/),
              name: 'apply_patch',
              input: '*** Begin Patch\n*** End Patch\n',
            },
          ]);
        },
      });
  return cases;
}
