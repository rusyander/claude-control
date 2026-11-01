import { describe, expect, it } from 'vitest';
import { parseCommand } from '@agentdeck/contracts/core/commands';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { commandEnvelope, newUuidv7 } from './command';
import { coreRefusalOf } from './refusal';
import { createSseParser, followCoreEvents, type SseEvent } from './sse';

/**
 * Клиент панели к ядру: разбор потока по кускам сети, возобновление с `Last-Event-ID` после
 * обрыва, конверт команды, который принимает схема ядра, коды отказа прокладки.
 */

const encoder = new TextEncoder();

/** Ответ, тело которого отдаёт куски по одному и затем кончается или рвётся. */
function streamResponse(chunks: string[], end: 'close' | 'error' = 'close'): Response {
  // По куску на чтение: ошибка потока стирает уже поставленные в очередь куски, а обрыв сети
  // приходит после доставленных.
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (end === 'close') controller.close();
      else controller.error(new Error('socket hang up'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('SSE parser', () => {
  it('frames split mid-line and mid-frame come out whole; comments give no events', () => {
    const parser = createSseParser();
    const out: SseEvent[] = [];
    for (const chunk of [
      ': open\n\nid: 1\nevent: task.cr',
      'eated\ndata: {"seq":1}\n',
      '\n: ping\r\n\r\nid: 2\ndata: a\ndata: b\n\n',
    ])
      out.push(...parser.push(chunk));
    expect(out).toEqual([
      { id: '1', event: 'task.created', data: '{"seq":1}' },
      { id: '2', event: 'message', data: 'a\nb' },
    ]);
  });
});

describe('followCoreEvents', () => {
  it('resumes after a drop with Last-Event-ID of the last event received, no line twice', async () => {
    const abort = new AbortController();
    const asked: (string | null)[] = [];
    const replies = [
      streamResponse(['id: 4\ndata: x\n\n', 'id: 5\ndata: y\n\n'], 'error'),
      streamResponse(['id: 6\ndata: z\n\n']),
    ];
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get('last-event-id'));
      const next = replies.shift();
      if (!next) {
        abort.abort();
        throw new Error('aborted');
      }
      return next;
    }) as typeof fetch;
    const last = await followCoreEvents({
      url: '/api/core/tasks/t/events',
      lastEventId: '3',
      signal: abort.signal,
      onEvent: (event) => seen.push(event.id ?? ''),
      fetchImpl,
      sleep: async () => {},
    });
    expect(asked).toEqual(['3', '5', '6']);
    expect(seen).toEqual(['4', '5', '6']);
    expect(last).toBe('6');
  });

  it('a stream that goes silent past idleMs is dropped and resumed with Last-Event-ID, no line twice', async () => {
    const abort = new AbortController();
    const asked: (string | null)[] = [];
    // Первый ответ отдаёт строку и замолкает навсегда: сокет открыт, данных нет (сон, прокси).
    const silent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 7\ndata: x\n\n'));
      },
    });
    const replies = [
      new Response(silent, { status: 200 }),
      // Звено не поняло Last-Event-ID и повторило хвост: 7 уже показана, второй раз не уходит.
      streamResponse(['id: 7\ndata: x\n\nid: 8\ndata: y\n\n']),
    ];
    const seen: string[] = [];
    const drops: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get('last-event-id'));
      const next = replies.shift();
      if (!next) {
        abort.abort();
        throw new Error('aborted');
      }
      return next;
    }) as typeof fetch;
    const last = await followCoreEvents({
      url: '/api/core/tasks/t/events',
      signal: abort.signal,
      onEvent: (event) => seen.push(event.id ?? ''),
      onDrop: (reason) => drops.push(reason),
      fetchImpl,
      sleep: async () => {},
      idleMs: 50,
    });
    expect(asked).toEqual([null, '7', '8']);
    expect(seen).toEqual(['7', '8']);
    expect(drops[0]).toBe('idle 50 ms');
    expect(last).toBe('8');
  }, 5_000);

  it('pings closer than idleMs keep a long stream alive: no idle drop', async () => {
    const abort = new AbortController();
    // Шесть кусков через 20 мс при сроке 50 мс: поток живёт втрое дольше срока, но не молчит.
    let sent = 0;
    const lively = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((done) => setTimeout(done, 20));
        sent += 1;
        controller.enqueue(encoder.encode(sent === 6 ? 'id: 1\ndata: x\n\n' : ': ping\n\n'));
        if (sent === 6) controller.close();
      },
    });
    const replies = [new Response(lively, { status: 200 })];
    const drops: string[] = [];
    const fetchImpl = (async () => {
      const next = replies.shift();
      if (!next) {
        abort.abort();
        throw new Error('aborted');
      }
      return next;
    }) as typeof fetch;
    const last = await followCoreEvents({
      url: '/api/core/tasks/t/events',
      signal: abort.signal,
      onEvent: () => {},
      onDrop: (reason) => drops.push(reason),
      fetchImpl,
      sleep: async () => {},
      idleMs: 50,
    });
    expect(drops[0]).toBe('stream ended');
    expect(last).toBe('1');
  }, 5_000);

  it('a refusal (not 200) ends the stream and is reported, never retried', async () => {
    let calls = 0;
    const refusals: number[] = [];
    await followCoreEvents({
      url: '/x',
      signal: new AbortController().signal,
      onEvent: () => {},
      onRefusal: (status) => refusals.push(status),
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{"code":"core-unverified"}', { status: 503 });
      }) as typeof fetch,
      sleep: async () => {},
    });
    expect([calls, refusals]).toEqual([1, [503]]);
  });
});

describe('command envelope', () => {
  it('a fresh UUIDv7 carries the time and version; the envelope passes the core schema', () => {
    const id = newUuidv7(Date.UTC(2026, 10, 1));
    expect(isUuidv7(id)).toBe(true);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 1));
    const envelope = commandEnvelope(
      { kind: 'pause', taskId: newUuidv7(), fields: { now: false }, expectSeq: 7 },
      'n-1',
      newUuidv7(),
    );
    // Тот же разбор, что у ядра на `POST /v1/commands`: конверт и поля вида.
    expect(parseCommand(envelope)).toEqual({ ok: true, command: envelope });
    expect(envelope.proof).toEqual({ nonce: 'n-1', page: envelope.proof.page });
  });
});

describe('proxy refusal codes', () => {
  it('reads the code from an axios error or a body; anything else is not a core refusal', () => {
    expect(coreRefusalOf({ response: { data: { code: 'core-unverified' } } })).toBe(
      'core-unverified',
    );
    expect(coreRefusalOf({ code: 'core-absent' })).toBe('core-absent');
    expect(coreRefusalOf({ response: { data: { code: 'no-task' } } })).toBeUndefined();
    expect(coreRefusalOf('core-absent')).toBeUndefined();
  });
});
