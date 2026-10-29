import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { mapQwenPermission } from '../qwen/permission.ts';
import { SdkNormaliser, type SdkRule } from './normalise.ts';

/** core-s2 F-38 / F-98: учёт ожидания отправок, влитое эхо, учёт без частичных событий. */

const NO_ECHO: SdkRule = { echo: false, mapPermission: mapQwenPermission };
const ECHO: SdkRule = { echo: true, mapPermission: mapQwenPermission };

const line = (o: object): string => JSON.stringify(o);
const feed = (n: SdkNormaliser, lines: object[]): AdapterEvent[] =>
  lines.flatMap((o) => n.push(line(o)));
const result = (over: object = {}): object => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'done',
  ...over,
});

describe('sdk normaliser: core-s2 fixes', () => {
  it('F-38 an error result with no open turn releases the waiting send (no echo)', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      result({ subtype: 'error_during_execution', is_error: true, errors: ['No saved session'] }),
    ]);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(n.waiting).toBe(0);
  });

  it('F-38 forget() drops a send the host refused, so the pump is not blocked', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    n.expect('c2', 'u2');
    n.forget('c1');
    expect(n.waiting).toBe(1);
    const events = feed(n, [{ type: 'system', subtype: 'init', session_id: 's' }, result()]);
    expect(events.filter((e) => e.type === 'turn.ended')).toMatchObject([{ attribution: 'c2' }]);
  });

  it('F-38 a second echo mid-turn is folded: both commands end on the result', () => {
    const n = new SdkNormaliser(ECHO);
    n.expect('c1', 'u1');
    n.expect('c2', 'u2');
    const events = feed(n, [
      { type: 'user', isReplay: true, uuid: 'u1' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', isReplay: true, uuid: 'u2' },
      { type: 'user', isReplay: true, uuid: 'u2' },
      result(),
    ]);
    const turns = events
      .filter((e) => e.type === 'turn.started' || e.type === 'turn.ended')
      .map((e) => `${e.type} ${'attribution' in e ? e.attribution : ''}`);
    expect(turns).toEqual(['turn.started c1', 'turn.started c2', 'turn.ended c1', 'turn.ended c2']);
    expect(n.busy).toBe(false);
  });

  it('F-98 usage of assistant messages without stream events is emitted at the result', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 2 } } },
      { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 7, output_tokens: 3 } } },
      result(),
    ]);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toMatchObject([
      { messageId: 'm1', input: 5, output: 2 },
      { messageId: 'm2', input: 7, output: 3 },
    ]);
  });

  it('F-98 usage that grows after it was emitted is re-issued with the full numbers once', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 4 } } },
      },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'stream_event',
        api_message_id: 'm1',
        event: { type: 'message_delta', usage: { output_tokens: 9 } },
      },
      result(),
    ]);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toMatchObject([
      { messageId: 'm1', input: 4, output: 0 },
      { messageId: 'm1', input: 4, output: 9 },
    ]);
    expect(n.usage()).toMatchObject([{ messageId: 'm1', input: 4, output: 9 }]);
  });
});
