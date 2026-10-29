/**
 * Оракул проверяется сам: примеры потоков из опубликованной документации (Anthropic
 * «Streaming messages», OpenAI «Chat streaming», «Responses streaming») он
 * принимает, а тот же поток со сломанным одним байтом кадра — отвергает. Без этого
 * зелёный набор совместимости мог бы значить «клиент подогнан под заглушку».
 */
import { describe, expect, it } from 'vitest';
import { readAnthropicStream } from './anthropic.ts';
import { readChatStream } from './openai-chat.ts';
import { readResponsesStream } from './openai-responses.ts';
import { parseSse } from './sse.ts';

const sse = (events: [string | null, unknown][]) =>
  events
    .map(
      ([event, data]) =>
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('');

/** Документация Anthropic: текст и вызов инструмента с дробным `partial_json`. */
const ANTHROPIC_TOOL = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_014p7gG3wDgGV9EUtLvnow3U',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4',
        stop_sequence: null,
        usage: { input_tokens: 472, output_tokens: 2 },
        content: [],
        stop_reason: null,
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  ['ping', { type: 'ping' }],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Okay' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', checking.' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: {},
      },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"location": "San Fra' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'ncisco, CA"}' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 89 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const chunk = (delta: unknown, finish: string | null = null) => ({
  id: 'chatcmpl-123',
  object: 'chat.completion.chunk',
  created: 1694268190,
  model: 'gpt-4o-mini',
  system_fingerprint: 'fp_44709d6fcb',
  choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
});

/** Справка OpenAI: поток чата с расходом (`stream_options.include_usage`). */
const CHAT = sse([
  [null, chunk({ role: 'assistant', content: '' })],
  [null, chunk({ content: 'Hello' })],
  [null, chunk({ content: '!' })],
  [null, chunk({}, 'stop')],
  [
    null,
    {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    },
  ],
  [null, '[DONE]'],
]);

/** Справка OpenAI: вызов функции потоком, аргументы дробно. */
const CHAT_TOOL = sse([
  [
    null,
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          index: 0,
          id: 'call_DdmO9pD3xa9XTPNJ32zg2hcA',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
      ],
    }),
  ],
  [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] })],
  [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] })],
  [null, chunk({}, 'tool_calls')],
  [
    null,
    {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ],
  [null, '[DONE]'],
]);

const ITEM = {
  id: 'msg_67c9fdcf37fc8190ba82116e33fb28c507b8b0ad4e5eb654',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Hi there!', annotations: [] }],
};
const RESP = {
  id: 'resp_67c9fdcecf488190bdd9a0409de3a1ec07b8b0ad4e5eb654',
  object: 'response',
  created_at: 1741290958,
};
const at = { item_id: ITEM.id, output_index: 0 };

/** Справка OpenAI: поток Responses с одним текстовым элементом. */
const RESPONSES = sse(
  (
    [
      [
        'response.created',
        { response: { ...RESP, status: 'in_progress', output: [], usage: null } },
      ],
      [
        'response.in_progress',
        { response: { ...RESP, status: 'in_progress', output: [], usage: null } },
      ],
      [
        'response.output_item.added',
        { output_index: 0, item: { ...ITEM, status: 'in_progress', content: [] } },
      ],
      [
        'response.content_part.added',
        { ...at, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      ],
      ['response.output_text.delta', { ...at, content_index: 0, delta: 'Hi' }],
      ['response.output_text.delta', { ...at, content_index: 0, delta: ' there!' }],
      ['response.output_text.done', { ...at, content_index: 0, text: 'Hi there!' }],
      ['response.content_part.done', { ...at, content_index: 0, part: ITEM.content[0] }],
      ['response.output_item.done', { output_index: 0, item: ITEM }],
      [
        'response.completed',
        {
          response: {
            ...RESP,
            status: 'completed',
            output: [ITEM],
            usage: {
              input_tokens: 37,
              output_tokens: 11,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 48,
            },
          },
        },
      ],
    ] as [string, Record<string, unknown>][]
  ).map(([type, data], seq) => [type, { type, ...data, sequence_number: seq }]),
);

describe('oracle accepts the published examples', () => {
  it('anthropic: text + tool_use with split partial_json', () => {
    expect(readAnthropicStream(ANTHROPIC_TOOL)).toEqual({
      kind: 'message',
      id: 'msg_014p7gG3wDgGV9EUtLvnow3U',
      stopReason: 'tool_use',
      usage: { input: 472, output: 89 },
      parts: [
        { kind: 'text', text: 'Okay, checking.' },
        {
          kind: 'tool',
          id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
          name: 'get_weather',
          args: { location: 'San Francisco, CA' },
        },
      ],
    });
  });

  it('openai-chat: text with a usage chunk; tool call with split arguments', () => {
    expect(readChatStream(CHAT)).toMatchObject({
      parts: [{ kind: 'text', text: 'Hello!' }],
      stopReason: 'stop',
      usage: { input: 9, output: 2 },
    });
    expect(readChatStream(CHAT_TOOL)).toMatchObject({
      parts: [{ kind: 'tool', name: 'get_weather', args: { location: 'Paris' } }],
      stopReason: 'tool_calls',
    });
  });

  it('openai-responses: one message item', () => {
    expect(readResponsesStream(RESPONSES)).toMatchObject({
      parts: [{ kind: 'text', text: 'Hi there!' }],
      usage: { input: 37, output: 11 },
    });
  });

  it('SSE: CRLF and CR line ends, comments, multi-line data, one optional space', () => {
    expect(parseSse(': comment\r\nevent: x\r\ndata: a\r\ndata:b\r\n\r\ndata:  two\r\r')).toEqual([
      { event: 'x', data: 'a\nb', named: true },
      { event: 'message', data: ' two', named: false },
    ]);
  });
});

describe('oracle rejects one broken byte of framing', () => {
  const broken: [string, () => unknown, RegExp][] = [
    [
      'anthropic: last blank line missing',
      () => readAnthropicStream(ANTHROPIC_TOOL.slice(0, -1)),
      /unterminated event/,
    ],
    [
      'anthropic: field name typo',
      () =>
        readAnthropicStream(ANTHROPIC_TOOL.replace('data: {"type":"ping"', 'dat: {"type":"ping"')),
      /unknown field/,
    ],
    [
      'anthropic: event name ≠ type',
      () =>
        readAnthropicStream(ANTHROPIC_TOOL.replace('event: message_stop', 'event: message_stoq')),
      /unexpected event name/,
    ],
    [
      'anthropic: blank line between event and data',
      () => readAnthropicStream(ANTHROPIC_TOOL.replace('event: ping\n', 'event: ping\n\n')),
      /event ping carries|first event|unexpected/,
    ],
    [
      'anthropic: message_stop lost',
      () => readAnthropicStream(ANTHROPIC_TOOL.replace(/event: message_stop\n.*\n\n$/, '')),
      /without message_stop/,
    ],
    [
      'chat: [DONE] lost',
      () => readChatStream(CHAT.replace('data: [DONE]\n\n', '')),
      /without \[DONE\]/,
    ],
    ['chat: stream cut mid-line', () => readChatStream(CHAT.slice(0, -2)), /mid-line|unterminated/],
    ['chat: event name on a chunk', () => readChatStream(`event: x\n${CHAT}`), /named event/],
    [
      'chat: broken JSON byte',
      () => readChatStream(CHAT.replace('"Hello"', '"Hello')),
      /data is not JSON/,
    ],
    [
      'responses: sequence gap',
      () => readResponsesStream(RESPONSES.replace('"sequence_number":4', '"sequence_number":5')),
      /sequence_number/,
    ],
    [
      'responses: delta differs from done',
      () => readResponsesStream(RESPONSES.replace('"delta":"Hi"', '"delta":"Ho"')),
      /differs/,
    ],
    [
      'responses: completed lost',
      () => readResponsesStream(RESPONSES.replace(/event: response\.completed\n.*\n\n$/, '')),
      /without response.completed/,
    ],
  ];
  it.each(broken)('%s', (_name, run, error) => {
    expect(run).toThrow(error);
  });
});
