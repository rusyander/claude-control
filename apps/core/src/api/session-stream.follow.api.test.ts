import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_STREAM_SSE_EVENT,
  sessionEventKeys,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { appendIoRecord, IO_RECORD } from '../adapters/sdk-stream/io-record.ts';
import { fixturePath } from '../adapters/conformance/__fixtures__/replay.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Поток вида сеанса (`?follow=1`, этап 10) на настоящем API и нормализаторе Claude: сеанс растёт
 * на диске, как его пишет хост (записанный поток настоящего CLI, два хода), — кадр `page` на
 * каждую порцию, ход человека на границе курсора ровно раз, конец сеанса закрывает поток,
 * обрыв возобновляется по `Last-Event-ID` без потери и без повтора.
 */

const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';
let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

interface Frame {
  id?: string;
  event: string;
  data: { events: SessionStreamEvent[]; next: number; done: boolean };
}

const fixtureLines = (): string[] =>
  readFileSync(fixturePath('claude', 'basic'), 'utf8').split('\n').filter(Boolean);

function sendLine(cmdId: string, at: number, text: string): string {
  const data = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  return `${JSON.stringify({ t: 'send', cmdId, uuid: cmdId, at, data })}\n`;
}

function seed(s: Stand): { sid: string; dir: string } {
  const task = s.registry.live(s.taskId)!;
  const sid = newId();
  task.append({
    kind: 'session.started',
    actor: 'core',
    sessionId: sid,
    data: {
      sessionId: sid,
      stepId: newId(),
      adapter: 'claude',
      cliVersion: '1',
      route: { kind: 'cli-login', id: 'login' },
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: 'start',
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  const dir = join(s.layout.tasks, s.taskId, 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  // Первый ход: строки 0–13 записи (до `completed` первой команды), слово человека на нуле.
  writeFileSync(join(dir, 'stdout.log'), `${fixtureLines().slice(0, 14).join('\n')}\n`);
  writeFileSync(join(dir, IO_RECORD), sendLine(ONE, 0, 'hello one'));
  return { sid, dir };
}

function parseFrame(raw: string): Frame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (!event) return null;
  return { ...(id !== undefined ? { id } : {}), event, data: JSON.parse(data.join('\n')) };
}

/** Читатель кадров SSE поверх `fetch`: копит кадры, ждёт условие. */
function reader(res: Response) {
  const frames: Frame[] = [];
  const state = { ended: false };
  const decoder = new TextDecoder();
  let buffer = '';
  const body = res.body!.getReader();
  void (async () => {
    for (;;) {
      const got = await body.read();
      if (got.done) break;
      buffer += decoder.decode(got.value, { stream: true });
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const frame = parseFrame(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (frame) frames.push(frame);
      }
    }
    state.ended = true;
  })().catch(() => {
    state.ended = true;
  });
  return {
    frames,
    state,
    async until(ok: () => boolean, ms = 5000) {
      const t0 = Date.now();
      while (!ok()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout; frames=${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    cancel: () => body.cancel().catch(() => undefined),
  };
}

const texts = (frames: Frame[], kind: string) =>
  frames
    .flatMap((f) => f.data.events)
    .filter((e) => e.kind === kind)
    .map((e) => (e.data as { text?: string }).text);

const kinds = (frames: Frame[]) => frames.flatMap((f) => f.data.events).map((e) => e.kind);

describe('GET /v1/tasks/:id/sessions/:sid/stream?follow=1 (stage 10, SSE)', () => {
  it('a page per growth; the human turn at the cursor boundary once; the session end closes the stream with done', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    const { sid, dir } = seed(stand);
    const res = await stand.get(`/v1/tasks/${stand.taskId}/sessions/${sid}/stream?follow=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const r = reader(res);
    await r.until(() => texts(r.frames, 'assistant-text').includes('REPLY_0'));
    expect(r.frames[0]?.event).toBe(SESSION_STREAM_SSE_EVENT);
    expect(texts(r.frames, 'user-text')).toEqual(['hello one']);
    const cursor = r.frames.at(-1)!.data.next;
    expect(r.frames.at(-1)!.id).toBe(String(cursor));

    // Ход человека ушёл после последней целой строки: он стоит на курсоре.
    const size = readFileSync(join(dir, 'stdout.log')).length;
    appendFileSync(join(dir, IO_RECORD), sendLine(TWO, size, 'second'));
    await r.until(() => texts(r.frames, 'user-text').includes('second'));
    // Ответ на него: следующая страница читает с курсора, где стоит тот же ход, — не повтор.
    appendFileSync(join(dir, 'stdout.log'), `${fixtureLines().slice(14).join('\n')}\n`);
    await r.until(() => texts(r.frames, 'assistant-text').includes('REPLY_1'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(texts(r.frames, 'user-text')).toEqual(['hello one', 'second']);
    const all = r.frames.flatMap((f) => f.data.events);
    expect(new Set(sessionEventKeys(all)).size).toBe(all.length);
    expect(r.state.ended).toBe(false);

    stand.registry.live(stand.taskId)!.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId: sid,
      data: { sessionId: sid, event: 'exited', from: 'starting', to: 'ended' },
    });
    await r.until(() => r.state.ended);
    expect(r.frames.at(-1)!.data.done).toBe(true);
  });

  // Зона C, проход 8 (находка G7 §Pass 5): насос пишет отправку на СВОЁ смещение (`at`), а оно
  // отстаёт от файла — CLI успел написать строку, которую вид уже прочёл и увёл курсор за `at`.
  // До прохода 8 такой ход человека в живую ленту не попадал никогда («живьём 0, после
  // перезагрузки 1»). Запись — настоящим писателем насоса (`appendIoRecord`).
  it('a send recorded after the cursor passed its pump offset reaches the live feed exactly once', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    const { sid, dir } = seed(stand);
    const url = `/v1/tasks/${stand.taskId}/sessions/${sid}/stream?follow=1`;
    const r = reader(await stand.get(url));
    await r.until(() => kinds(r.frames).includes('turn-end'));
    const pump = readFileSync(join(dir, 'stdout.log')).length;
    // CLI пишет строку раньше, чем насос её прочёл; вид её прочёл — курсор ушёл за смещение насоса.
    appendFileSync(
      join(dir, 'stdout.log'),
      `${JSON.stringify({ type: 'system', subtype: 'status', status: null })}\n`,
    );
    const grown = readFileSync(join(dir, 'stdout.log')).length;
    await r.until(() => r.frames.at(-1)!.data.next === grown);
    const data = JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } });
    appendIoRecord(dir, { t: 'send', cmdId: TWO, uuid: TWO, at: pump, data });
    await r.until(() => texts(r.frames, 'user-text').includes('second'));
    // Ответ на ход и ещё несколько опросов: ход не повторяется.
    appendFileSync(join(dir, 'stdout.log'), `${fixtureLines().slice(14).join('\n')}\n`);
    await r.until(() => texts(r.frames, 'assistant-text').includes('REPLY_1'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(texts(r.frames, 'user-text')).toEqual(['hello one', 'second']);
    const all = r.frames.flatMap((f) => f.data.events);
    expect(new Set(sessionEventKeys(all)).size).toBe(all.length);
    const last = r.frames.at(-1)!.id!;
    await r.cancel();

    // Обрыв после хода: возобновление по `Last-Event-ID` его не повторяет.
    const again = reader(await stand.get(url, undefined, { 'last-event-id': last }));
    appendFileSync(
      join(dir, 'stdout.log'),
      `${JSON.stringify({ type: 'system', subtype: 'status', status: null })}\n`,
    );
    await again.until(() => again.frames.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(texts(again.frames, 'user-text')).toEqual([]);
    await again.cancel();
    // Перезагрузка (с нуля) — тот же разговор: каждый ход человека по разу.
    const reload = reader(await stand.get(url));
    await reload.until(() => texts(reload.frames, 'assistant-text').includes('REPLY_1'));
    expect(texts(reload.frames, 'user-text')).toEqual(['hello one', 'second']);
    await reload.cancel();
  });

  it('a reconnect with Last-Event-ID resumes after the cursor: the later turn arrives, nothing before it repeats', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    const { sid, dir } = seed(stand);
    const url = `/v1/tasks/${stand.taskId}/sessions/${sid}/stream?follow=1`;
    const first = reader(await stand.get(url));
    await first.until(() => kinds(first.frames).includes('turn-end'));
    const last = first.frames.at(-1)!.id!;
    await first.cancel();
    // Пока клиента нет (перезапуск панели), сеанс идёт дальше: второй ход целиком.
    const size = readFileSync(join(dir, 'stdout.log')).length;
    appendFileSync(join(dir, IO_RECORD), sendLine(TWO, size, 'second'));
    appendFileSync(join(dir, 'stdout.log'), `${fixtureLines().slice(14).join('\n')}\n`);
    const again = reader(await stand.get(url, undefined, { 'last-event-id': last }));
    await again.until(() => texts(again.frames, 'assistant-text').includes('REPLY_1'));
    expect(texts(again.frames, 'user-text')).toEqual(['second']);
    expect(texts(again.frames, 'assistant-text')).not.toContain('REPLY_0');
    await again.cancel();
  });
});
