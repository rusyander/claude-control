import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OPENCODE_BROKEN_REPLY, OpencodeServe } from './opencode-serve.ts';
import { runAssistant } from '../assistant-runner/assistant-runner.ts';
import { getProvider } from '../../providers/registry.ts';

/**
 * Шина событий `opencode serve` (`GET /event`): куски ответа, пока он пишется, и
 * причина упавшего хода. Формы кадров — из живой пробы OpenCode 1.18.35
 * (`message.part.updated` / `message.part.delta` / `session.error`). Настоящий
 * сервер не запускается: `spawn` и `fetch` подменены, тело `/event` — поток,
 * в который тест кладёт кадры, пока «идёт» сообщение. Живой прогон —
 * `tools/qa/check-foreign-first-talk.mjs --cli opencode`.
 */

function fakeChild(): EventEmitter & { pid: number; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
  child.pid = 4243;
  child.kill = () => child.emit('exit', 0);
  return child;
}

const json = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

type Emit = (event: unknown) => void;

interface EventServerOptions {
  /** Что сервер кладёт на шину, пока идёт сообщение. */
  during: (emit: Emit) => void;
  /** Тело ответа на сообщение; `undefined` — 500 без подробностей, как у OpenCode. */
  message?: unknown;
}

/** Подделка сервера OpenCode с шиной событий. */
function eventServer(options: EventServerOptions) {
  const encoder = new TextEncoder();
  const buses: ReadableStreamDefaultController<Uint8Array>[] = [];
  const emit: Emit = (event) => {
    for (const bus of buses) bus.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  let sessions = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\?.*$/, '');
    if (path === '/global/health') return json({});
    if (path === '/config') return json({});
    if (path === '/agent')
      return json([{ name: 'build', mode: 'primary', permission: [], options: {} }]);
    if (path === '/session') {
      sessions += 1;
      return json({ id: `ses_${sessions}` });
    }
    if (path === '/permission') return json([]);
    if (path === '/event') {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          buses.push(controller);
          controller.enqueue(
            encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
          );
        },
      });
      return { ok: true, body } as unknown as Response;
    }
    if (/^\/session\/[^/]+\/message$/.test(path)) {
      options.during(emit);
      // Кадры уходят читателю шины раньше, чем приходит тело ответа.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return options.message === undefined ? json({}, false) : json(options.message);
    }
    return json({}, false);
  });
  return { fetchImpl, sessions: () => sessions };
}

const deps = (fetchImpl: unknown, onDelta?: (text: string) => void) => ({
  command: 'opencode',
  spawnImpl: (() => fakeChild()) as never,
  fetchImpl: fetchImpl as never,
  port: 4098,
  permissionPollMs: 1,
  ...(onDelta ? { onDelta } : {}),
});

const textPart = (id: string, sessionID = 'ses_1') => ({
  type: 'message.part.updated',
  properties: { sessionID, part: { id, sessionID, messageID: 'msg_a', type: 'text', text: '' } },
});
const delta = (partID: string, text: string, sessionID = 'ses_1') => ({
  type: 'message.part.delta',
  properties: { sessionID, messageID: 'msg_a', partID, field: 'text', delta: text },
});

describe('OpencodeServe: шина событий', () => {
  it('куски текстового ответа идут наружу, пока он пишется; рассуждения и чужие сессии — нет', async () => {
    const { fetchImpl } = eventServer({
      during: (emit) => {
        emit({
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_1',
            part: { id: 'prt_r', sessionID: 'ses_1', messageID: 'msg_a', type: 'reasoning' },
          },
        });
        emit(delta('prt_r', 'думаю…'));
        emit(textPart('prt_t'));
        emit(delta('prt_t', 'При'));
        emit(textPart('prt_x', 'ses_other'));
        emit(delta('prt_x', 'чужое', 'ses_other'));
        emit(delta('prt_t', 'вет!'));
      },
      message: { info: {}, parts: [{ type: 'text', text: 'Привет!' }] },
    });
    const pieces: string[] = [];
    const serve = new OpencodeServe();

    const result = await serve.ask(
      'conv-1',
      'вопрос',
      deps(fetchImpl, (t) => pieces.push(t)),
    );

    expect(pieces).toEqual(['При', 'вет!']);
    expect(result).toEqual({ reply: 'Привет!', sessionId: 'ses_1' });
    serve.dispose();
  });

  it('модели нет: причина из session.error — неудача хода, не undefined; сессия жива', async () => {
    const { fetchImpl, sessions } = eventServer({
      during: (emit) =>
        emit({
          type: 'session.error',
          properties: {
            sessionID: 'ses_1',
            error: {
              name: 'UnknownError',
              data: { message: 'Model not found: opencode/nope. Did you mean: gpt-5-nano?' },
            },
          },
        }),
    });
    const serve = new OpencodeServe();

    const first = await serve.ask('conv-1', 'вопрос', deps(fetchImpl));
    expect(first).toEqual({
      error: 'Model not found: opencode/nope. Did you mean: gpt-5-nano?',
      sessionId: 'ses_1',
    });

    // Разговор продолжается в той же сессии — CLI помнит его, новую не заводим.
    await serve.ask('conv-1', 'ещё', deps(fetchImpl));
    expect(sessions()).toBe(1);
    serve.dispose();
  });

  it('куски ушли, а целого ответа нет — неудача, а не повтор хода одиночным запуском', async () => {
    const { fetchImpl } = eventServer({
      during: (emit) => {
        emit(textPart('prt_t'));
        emit(delta('prt_t', 'Начал'));
      },
    });
    const serve = new OpencodeServe();

    const result = await serve.ask(
      'conv-1',
      'вопрос',
      deps(fetchImpl, () => {}),
    );

    expect(result).toEqual({ error: OPENCODE_BROKEN_REPLY, sessionId: 'ses_1' });
    serve.dispose();
  });

  it('шины нет (404) — ответ целиком из тела, как раньше', async () => {
    const encoderless = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\?.*$/, '');
      if (path === '/agent')
        return json([{ name: 'build', mode: 'primary', permission: [], options: {} }]);
      if (path === '/session') return json({ id: 'ses_1' });
      if (path === '/event') return json({}, false);
      if (path.endsWith('/message'))
        return json({ info: {}, parts: [{ type: 'text', text: 'Целиком' }] });
      return json(path === '/permission' ? [] : {});
    });
    const pieces: string[] = [];
    const serve = new OpencodeServe();

    const result = await serve.ask(
      'conv-1',
      'вопрос',
      deps(encoderless, (t) => pieces.push(t)),
    );

    expect(pieces).toEqual([]);
    expect(result).toEqual({ reply: 'Целиком', sessionId: 'ses_1' });
    serve.dispose();
  });
});

describe('runAssistant: упавший ход сессии — неудача с причиной CLI', () => {
  it('ok:false, причина CLI, one-shot не запускался', async () => {
    const spawnImpl = vi.fn();
    const serve = {
      ask: async () => ({ error: 'Model not found: opencode/nope.', sessionId: 'ses_3' }),
    } as unknown as OpencodeServe;

    const result = await runAssistant(
      getProvider('opencode'),
      [{ role: 'user', content: 'вопрос' }],
      {
        appDataDir: 'C:/tmp/nowhere',
        conversationId: 'conv-1',
        sessionServe: serve,
        detect: () => true,
        spawnImpl: spawnImpl as never,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      mode: 'cli',
      transport: 'session',
      reason: 'cli_error',
      error: 'Model not found: opencode/nope.',
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
