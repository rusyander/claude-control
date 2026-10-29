/**
 * Форма сценария проверяется при запуске (F-75): шаг-данные с опечаткой раньше стартовал и
 * отвечал 200 «STUB SCRIPT FAILED» — проверка, ждущая 429, проходила по тексту. Задержка
 * `Infinity` или ≥ 2^31 мс держит до `release()` (F-76), а не сводится Node к 1 мс. Мелочи
 * F-119: тело-не-объект у `route`, окно `rejected` у OpenAI.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startStubModel, type RouteRequest, type StubModel } from './index.mjs';
import { call } from './clients/call.ts';

const open: StubModel[] = [];
const start = async (options: Parameters<typeof startStubModel>[0]) => {
  const stub = await startStubModel(options);
  open.push(stub);
  return stub;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((stub) => stub.close()));
});

const refuses = (script: unknown, error: RegExp) =>
  expect(() => startStubModel({ script: script as never })).toThrow(error);

describe('a step given as data is checked at start (F-75)', () => {
  it.each([
    ['typo in a step key', [{ eror: { status: 429 } }], /steps\[0\]: unknown step key «eror»/],
    ['typo in a rule step', { rules: [{ when: 'x', step: { txt: 'a' } }] }, /rules\[0\]\.step: /],
    ['malformed fallback', { fallback: { text: 5 } }, /fallback: .*step\.text/],
    ['function fallback', { fallback: () => 'x' }, /fallback must be a step/],
    ['rules not an array', { rules: { when: 'x', step: 'a' } }, /rules must be an array/],
    ['times below one', { rules: [{ when: 'x', step: 'a', times: 0 }] }, /times must be/],
    ['times not an integer', { rules: [{ when: 'x', step: 'a', times: 1.5 }] }, /times must be/],
    ['times as a string', { rules: [{ when: 'x', step: 'a', times: '2' }] }, /times must be/],
    ['tools not an array', [{ tools: { name: 'x' } }], /step\.tools must be an array/],
    [
      'tool key typo',
      [{ tool: { name: 'x', arguments: {} } }],
      /unknown step\.tool key «arguments»/,
    ],
    ['custom key typo', [{ custom: { name: 'x', input: '', ip: 1 } }], /unknown step\.custom key/],
    ['error key typo', [{ error: { status: 429, retryafter: 1 } }], /unknown step\.error key/],
    ['error type not a string', [{ error: { status: 429, type: 5 } }], /step\.error\.type/],
    ['headers as a string', [{ text: 'x', headers: 'ab' }], /step\.headers must be an object/],
    ['header value an object', [{ text: 'x', headers: { a: {} } }], /step\.headers\.a/],
    ['window NaN', [{ text: 'x', window: { utilization: NaN } }], /window\.utilization/],
    ['window status', [{ text: 'x', window: { status: 'nope' } }], /window\.status/],
    ['window key typo', [{ text: 'x', window: { utilisation: 1 } }], /unknown step\.window key/],
    ['usage NaN', [{ text: 'x', usage: { input: NaN } }], /usage\.input/],
    ['retryAfter Infinity', [{ error: { status: 429, retryAfter: Infinity } }], /retryAfter/],
  ])('%s → refused at start', (_name, script, error) => refuses(script, error));

  it('a well-formed data script still starts and answers its scripted status', async () => {
    const stub = await start({
      script: {
        rules: [{ when: 'MARK', step: { error: { status: 429, retryAfter: 3 } }, times: 1 }],
        steps: [{ text: 'a', headers: { 'x-n': '1' }, window: { utilization: 0.5 } }],
        fallback: 'END',
      },
    });
    const limited = await call(stub.baseUrl, 'openai-chat', { text: 'MARK', stream: false });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    const first = await call(stub.baseUrl, 'openai-chat', { text: 'MARK', stream: false });
    expect(first.reply).toMatchObject({ parts: [{ text: 'a' }] });
    expect(first.headers.get('x-n')).toBe('1');
  });
});

describe('a hold longer than a Node timer holds until release (F-76)', () => {
  it.each([Infinity, 2 ** 31, 2 ** 40])('holdMs %s', async (holdMs) => {
    const stub = await start({ script: [{ text: 'held', holdMs }] });
    let answered = false;
    const pending = call(stub.baseUrl, 'anthropic-messages', { text: 'x', stream: true }).then(
      (outcome) => {
        answered = true;
        return outcome;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stub.holding()).toBe(true);
    expect(answered).toBe(false);
    stub.release();
    expect((await pending).reply).toMatchObject({ parts: [{ text: 'held' }] });
    expect(stub.holding()).toBe(false);
  });

  it('stallMs Infinity keeps the stream open until release', async () => {
    const stub = await start({ script: [{ text: 'after', stallMs: Infinity }] });
    const pending = call(stub.baseUrl, 'openai-responses', { text: 'x', stream: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stub.holding()).toBe(true);
    stub.release();
    expect((await pending).reply).toMatchObject({ parts: [{ text: 'after' }] });
  });
});

describe('F-119 nits', () => {
  it.each(['5', 'null', '"text"', '[1]'])('route body for JSON %s is undefined', async (raw) => {
    const seen: RouteRequest[] = [];
    const stub = await start({
      route: (request) => {
        seen.push(request);
        return { body: 'ok' };
      },
    });
    await fetch(`${stub.baseUrl}/own`, { method: 'POST', body: raw });
    expect(seen[0]!.raw).toBe(raw);
    expect(seen[0]!.body).toBeUndefined();
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    '%s: window status rejected → no requests left',
    async (dialect) => {
      const stub = await start({ script: [{ text: 'x', window: { status: 'rejected' } }] });
      const outcome = await call(stub.baseUrl, dialect, { text: 'x', stream: false });
      expect(outcome.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    },
  );
});
