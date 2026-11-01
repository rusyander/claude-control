import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionFile } from '../../session-host/protocol.ts';
import type { AdapterErrorCode, AdapterEvent } from '../adapter.types.ts';
import type { SdkRule } from './normalise.ts';
import { SdkSession } from './session.ts';

/**
 * Насос сессии без хоста: каталог сеанса пишет сам тест (stdout.log, exit.json), как его пишет
 * хост. Подключиться к хосту насосу некуда — так видны отказы, которых живой сеанс не даёт:
 * закрытие, остановка, кончившаяся сессия, нечитаемый исход, управляющие запросы без ответчика.
 */

const opened: SdkSession[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const asks: unknown[] = [];
function rule(over: Partial<SdkRule> = {}): SdkRule {
  return {
    echo: true,
    mapPermission: (raw) => {
      asks.push(raw);
      return { action: 'exec', target: raw.tool, tool: raw.tool, display: raw.tool };
    },
    ...over,
  };
}

function dir(lines: unknown[] = [], exit?: unknown, stderr?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'sdk-session-'));
  writeFileSync(sessionFile(d, 'stdout'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  if (stderr !== undefined) writeFileSync(sessionFile(d, 'stderr'), stderr);
  if (exit !== undefined) {
    writeFileSync(sessionFile(d, 'exit'), typeof exit === 'string' ? exit : JSON.stringify(exit));
  }
  return d;
}

function open(d: string, r: SdkRule = rule(), options = {}): SdkSession {
  const s = new SdkSession(d, r, { pollMs: 10, ...options });
  opened.push(s);
  return s;
}

async function drain(s: SdkSession, ms = 5_000): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  const timer = setTimeout(() => s.close(), ms);
  for await (const e of s.events()) out.push(e);
  clearTimeout(timer);
  return out;
}

const EXIT = { v: 1, code: 0, signal: null, stopped: false, at: 1 };

describe('sdk-stream session pump — edges no live session gives', () => {
  it('close fails the queued sends and ends the event stream', async () => {
    const s = open(dir());
    const sent = s.send('not-a-uuid', 'hello');
    s.close();
    await expect(sent).rejects.toThrow(/session closed|session not live/);
    expect(await drain(s)).toEqual([]);
  });

  it('a send with no live host fails with the attach state, a repeated cmdId shares the outcome', async () => {
    const s = open(dir());
    const first = s.send('cmd-1', 'hello');
    await expect(first).rejects.toThrow(/session not live: lost/);
    await expect(s.send('cmd-1', 'hello')).rejects.toThrow(/session not live/);
  });

  it('quiesce refuses queued and later sends and every control answer', async () => {
    const s = open(dir());
    await s.quiesce();
    await expect(s.send('cmd-2', 'late')).rejects.toThrow(/session stopping/);
    await expect(s.answerControl('r1', { behavior: 'deny' })).rejects.toThrow(/session stopping/);
  });

  it('an exit with an unreadable record ends the stream as exited, then sends and answers refuse', async () => {
    const s = open(dir([], '{not json'));
    const events = await drain(s);
    expect(events).toEqual([{ type: 'error', code: 'exited', detail: 'exit record unreadable' }]);
    await expect(s.send('cmd-3', 'late')).rejects.toThrow(/session ended/);
    await expect(s.answerControl('r1', {})).rejects.toThrow(/session ended/);
  });

  it('the exit detail names the refusal and the stderr tail; a classified stderr is the code once', async () => {
    const refused = open(dir([], { ...EXIT, code: 1, refused: 'cwd missing' }, 'boom'));
    expect((await drain(refused)).at(-1)).toEqual({
      type: 'error',
      code: 'exited',
      detail: 'code 1, refused: cwd missing; boom',
    });

    const classify = (text: string): AdapterErrorCode | null =>
      text.includes('gone') ? 'fresh-required' : null;
    // Отказ пришёл строкой потока — выход называется просто выходом.
    const streamed = open(
      dir(
        [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['gone'] }],
        { ...EXIT, code: 1 },
        'gone',
      ),
      rule({ classifyError: classify }),
    );
    const codes = (await drain(streamed)).map((e) => e.type === 'error' && e.code);
    expect(codes).toEqual(['fresh-required', 'exited']);

    // Только stderr при выходе — код по правилу переходника.
    const late = open(dir([], { ...EXIT, code: 1 }, 'gone'), rule({ classifyError: classify }));
    expect((await drain(late)).map((e) => e.type === 'error' && e.code)).toEqual([
      'fresh-required',
    ]);
  });

  it('a control request the core never declared is refused, a refused permission question becomes a denied ask', async () => {
    asks.length = 0;
    const s = open(
      dir(
        [
          { type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } },
          {
            type: 'control_request',
            request_id: 'p1',
            request: { subtype: 'can_use_tool', tool_name: 7, input: null },
          },
          {
            type: 'control_request',
            request_id: 'p2',
            request: { subtype: 'can_use_tool', tool_name: 'x', input: {}, tool_use_id: 'toolu_9' },
          },
          { type: 'control_request', request: { subtype: 'can_use_tool' } },
        ],
        EXIT,
      ),
    );
    const events = await drain(s);
    expect(events[0]).toMatchObject({ type: 'error', code: 'protocol' });
    // Имя не строка, вход не объект — вопрос всё равно сопоставлен и отказан.
    expect(events).toContainEqual({
      type: 'ask',
      ask: { action: 'exec', target: '', tool: '', display: '' },
      denied: true,
    });
    // id вызова в вопросе — в событии (W P-c: отказ сводится с вызовом).
    expect(events).toContainEqual({
      type: 'ask',
      ask: { action: 'exec', target: 'x', tool: 'x', display: 'x' },
      denied: true,
      toolUseId: 'toolu_9',
    });
    expect(asks).toEqual([
      { tool: '', input: {} },
      { tool: 'x', input: {} },
    ]);
    expect(events.some((e) => e.type === 'permit.request')).toBe(false);
  });

  it('with the core as answerer the permission question is an event, not an ask', async () => {
    const s = open(
      dir(
        [
          {
            type: 'control_request',
            request_id: 'p2',
            request: { subtype: 'can_use_tool', tool_name: 'x' },
          },
        ],
        EXIT,
      ),
      rule(),
      { permit: 'core' },
    );
    const events = await drain(s);
    expect(events[0]).toEqual({
      type: 'permit.request',
      requestId: 'p2',
      raw: { subtype: 'can_use_tool', tool_name: 'x' },
    });
    expect(events.some((e) => e.type === 'ask')).toBe(false);
  });

  it('an initialize that cannot be written holds the sends of an idle session', async () => {
    const s = open(dir(), rule(), { initialize: { subtype: 'initialize' } });
    const sent = s.send('cmd-4', 'held');
    let settled = false;
    void sent.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Десятки тактов: initialize повторяется каждым, сообщение не уходит.
    await new Promise((r) => setTimeout(r, 300));
    // Без initialize CLI понял бы сообщение не так: оно ждёт, а не уходит и не падает.
    expect(settled).toBe(false);
    s.close();
    await expect(sent).rejects.toThrow(/session closed/);
  });

  it('reading starts at the given offset and the position follows the bytes read', async () => {
    const line = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c1', model: 'm' })}\n`;
    const d = dir();
    writeFileSync(sessionFile(d, 'stdout'), `garbage-before\n${line}`);
    const s = open(d, rule(), { fromOffset: 'garbage-before\n'.length });
    const first = await s.events().next();
    expect(first.value).toMatchObject({ type: 'init' });
    expect(s.conversationId).toBe('c1');
    expect(s.position).toBe(Buffer.byteLength(`garbage-before\n${line}`));
  });

  it('a send to a closed or stopping session is refused at once, before any pump tick', async () => {
    const outcome = (p: Promise<unknown>): { msg?: string } => {
      const box: { msg?: string } = {};
      p.catch((e: Error) => (box.msg = e.message));
      return box;
    };
    const microtasks = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    const stopping = open(dir());
    await stopping.quiesce();
    const a = outcome(stopping.send('cmd-5', 'late'));
    const closed = open(dir());
    closed.close();
    const b = outcome(closed.send('cmd-6', 'late'));
    // Только микрозадачи: такт насоса (таймер) ещё не прошёл — отказ дала сама отправка.
    await microtasks();
    expect(a.msg).toBe('session stopping');
    expect(b.msg).toBe('session closed');
  });
});
