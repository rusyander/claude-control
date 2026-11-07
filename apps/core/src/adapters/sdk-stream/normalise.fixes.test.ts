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

/**
 * s11 w3 (f) «готовготов»: ход Qwen Code с фоновым субагентом — ответ после результата вызова,
 * уведомление CLI о конце субагента (`user`-текст без нашей отправки) и второй ответ модели в
 * том же ходе (форма списана со `stdout.log` живого прогона `check-chat-next-turn.mjs`).
 */
describe('sdk normaliser: separate model messages of one turn', () => {
  const message = (id: string, text: string): object[] => [
    { type: 'stream_event', event: { type: 'message_start', message: { id } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { type: 'assistant', message: { id, content: [{ type: 'text', text }] } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ];
  const texts = (events: AdapterEvent[]): string =>
    events.map((e) => (e.type === 'text.delta' ? e.text : '')).join('');

  it('the answer after a CLI notification is its own paragraph, not glued to the first', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      { type: 'system', subtype: 'init', session_id: 's' },
      ...message('m1', 'готов'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Background agent "general-purpose" completed.' }],
        },
      },
      ...message('m2', 'готов'),
      result({ result: 'готов', num_turns: 3 }),
    ]);
    expect(texts(events)).toBe('готов\n\nготов');
  });

  it('pieces of one message stay glued; the next turn starts without a separator', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    n.expect('c2', 'u2');
    const one = feed(n, [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      ...['гот', 'ов'].map((text) => ({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })),
      { type: 'stream_event', event: { type: 'message_stop' } },
      result(),
    ]);
    const two = feed(n, [...message('m2', 'дальше'), result()]);
    expect(texts(one)).toBe('готов');
    expect(texts(two)).toBe('дальше');
  });
});

/**
 * s11 w3: частичные строки подагента (`stream_event` с `parent_tool_use_id` — форма
 * `SDKPartialAssistantMessage` SDK: `parent_tool_use_id: string | null`, `uuid`, `session_id`)
 * идут вперемешку с частичными строками главного контекста. Текст подагента не ответ сессии,
 * а его `message_start` не начинает нового сообщения главного контекста.
 */
describe('sdk normaliser: subagent partial lines', () => {
  const partial = (event: object, parent: string | null, uuid: string): object => ({
    type: 'stream_event',
    event,
    parent_tool_use_id: parent,
    uuid,
    session_id: 's',
  });
  const text = (t: string): object => ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: t },
  });
  const interleaved = (): object[] => [
    { type: 'system', subtype: 'init', session_id: 's' },
    partial(
      { type: 'message_start', message: { id: 'p1', usage: { input_tokens: 4 } } },
      null,
      'a',
    ),
    partial(text('Запускаю'), null, 'b'),
    partial(
      {
        type: 'message_start',
        message: { id: 's1', model: 'sub-model', usage: { input_tokens: 7 } },
      },
      'toolu_task',
      'c',
    ),
    partial(text('секрет подагента'), 'toolu_task', 'd'),
    partial({ type: 'message_delta', usage: { output_tokens: 3 } }, 'toolu_task', 'e'),
    partial({ type: 'message_stop' }, 'toolu_task', 'f'),
    partial(text(' агента.'), null, 'g'),
    partial({ type: 'message_delta', usage: { output_tokens: 5 } }, null, 'h'),
    partial({ type: 'message_stop' }, null, 'i'),
    result({ result: 'Запускаю агента.' }),
  ];

  it('subagent text never reaches the session answer, and the parent message is not split', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, interleaved());
    const answer = events.map((e) => (e.type === 'text.delta' ? e.text : '')).join('');
    expect(answer).toBe('Запускаю агента.');
  });

  it('usage stays with its own message: the subagent row is marked, the parent row keeps its output', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const rows = feed(n, interleaved()).filter((e) => e.type === 'usage');
    const byId = new Map(rows.map((e) => [e.type === 'usage' ? e.messageId : '', e]));
    expect(byId.get('s1')).toEqual(
      expect.objectContaining({
        input: 7,
        output: 3,
        model: 'sub-model',
        subagent: true,
        parentToolUseId: 'toolu_task',
      }),
    );
    expect(byId.get('p1')).toEqual(
      expect.objectContaining({ input: 4, output: 5, parentToolUseId: null }),
    );
    expect(byId.get('p1')).not.toHaveProperty('subagent');
  });
});
