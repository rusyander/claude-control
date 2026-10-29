/**
 * Оракул отвергает поток, который нарушает его же заявленный контракт (F-77): нет
 * `stop_reason`/расхода, кадры после ошибки, дельта без `item_id` или не того вида, тип
 * ошибки, которого протокол не прислал. Раньше такие потоки проходили: `String(undefined)`
 * давал тип «undefined», и проверка ошибок совместимости не могла покраснеть.
 */
import { describe, expect, it } from 'vitest';
import { readAnthropicJson, readAnthropicStream } from './anthropic.ts';
import { readChatJson, readChatStream } from './openai-chat.ts';
import { readResponsesJson, readResponsesStream } from './openai-responses.ts';

const sse = (events: [string | null, unknown][]) =>
  events
    .map(
      ([event, data]) =>
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('');

type Patch = Record<string, unknown>;

/** Короткий поток Anthropic с текстом; `start`/`delta` подменяют поля начала и конца. */
function anthropic(
  options: { start?: Patch; delta?: Patch; tail?: [string, Patch][] } = {},
): string {
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 5, output_tokens: 1 },
          ...options.start,
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
        ...options.delta,
      },
    ],
    ['message_stop', { type: 'message_stop' }],
    ...(options.tail ?? []),
  ]);
}

const anthropicError = (tail: [string, unknown][] = []) =>
  sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ],
    ['error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }],
    ...tail,
  ]);

const chunk = (delta: unknown, finish: string | null = null, extra: Patch = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

const RESP = { id: 'resp_1', object: 'response', created_at: 1 };
const MSG = {
  id: 'msg_a',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'hi', annotations: [] }],
};

/** Поток Responses из событий без номеров: номера проставляются по порядку. */
const responses = (events: [string, Patch][]) =>
  sse(events.map(([type, data], seq) => [type, { type, ...data, sequence_number: seq }]));

const created: [string, Patch] = [
  'response.created',
  { response: { ...RESP, status: 'in_progress', output: [], usage: null } },
];
const added: [string, Patch] = [
  'response.output_item.added',
  { output_index: 0, item: { ...MSG, status: 'in_progress', content: [] } },
];
const at = { item_id: MSG.id, output_index: 0, content_index: 0 };

describe('oracle refuses streams that break its own contract (F-77)', () => {
  const broken: [string, () => unknown, RegExp][] = [
    [
      'anthropic: message_delta without stop_reason',
      () => readAnthropicStream(anthropic({ delta: { delta: { stop_sequence: null } } })),
      /anthropic stream: .*stop_reason/,
    ],
    [
      'anthropic: message_start without usage.input_tokens',
      () => readAnthropicStream(anthropic({ start: { usage: { output_tokens: 1 } } })),
      /anthropic stream: .*input_tokens/,
    ],
    [
      'anthropic: message_delta without usage.output_tokens',
      () => readAnthropicStream(anthropic({ delta: { usage: {} } })),
      /anthropic stream: .*output_tokens/,
    ],
    [
      'anthropic: an event after the error event',
      () => readAnthropicStream(anthropicError([['message_stop', { type: 'message_stop' }]])),
      /anthropic stream: .*after the error/,
    ],
    [
      'anthropic json: error body without error.type',
      () => readAnthropicJson({ type: 'error', error: { message: 'x' } }),
      /anthropic json: .*error\.type/,
    ],
    [
      'anthropic json: message without usage',
      () =>
        readAnthropicJson({
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [],
          stop_reason: 'end_turn',
        }),
      /anthropic json: .*usage/,
    ],
    [
      'chat: [DONE] after the error chunk',
      () =>
        readChatStream(
          sse([
            [null, chunk({ role: 'assistant', content: '' })],
            [null, { error: { message: 'busy', type: 'server_error' } }],
            [null, '[DONE]'],
          ]),
        ),
      /openai-chat stream: .*after the error/,
    ],
    [
      'chat: error chunk without error.type',
      () => readChatStream(sse([[null, { error: { message: 'busy' } }]])),
      /openai-chat stream: .*error\.type/,
    ],
    [
      'chat: finish_reason tool_calls with no tool call',
      () =>
        readChatStream(
          sse([
            [null, chunk({ role: 'assistant', content: 'x' })],
            [null, chunk({}, 'tool_calls', { usage: USAGE })],
            [null, '[DONE]'],
          ]),
        ),
      /openai-chat stream: .*tool_calls/,
    ],
    [
      'chat: usage on a content chunk before the end',
      () =>
        readChatStream(
          sse([
            [null, chunk({ role: 'assistant', content: 'x' }, null, { usage: USAGE })],
            [null, chunk({}, 'stop')],
            [null, '[DONE]'],
          ]),
        ),
      /openai-chat stream: .*usage/,
    ],
    [
      'chat json: error body without error.type',
      () => readChatJson({ error: { message: 'x' } }),
      /openai-chat json: .*error\.type/,
    ],
    [
      'chat json: completion without usage',
      () =>
        readChatJson({
          object: 'chat.completion',
          id: 'c',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' },
          ],
        }),
      /openai-chat json: .*usage/,
    ],
    [
      'responses: delta without item_id',
      () =>
        readResponsesStream(
          responses([
            created,
            added,
            ['response.output_text.delta', { output_index: 0, content_index: 0, delta: 'hi' }],
          ]),
        ),
      /openai-responses stream: .*not open/,
    ],
    [
      'responses: function_call_arguments.delta inside a message item',
      () =>
        readResponsesStream(
          responses([
            created,
            added,
            ['response.function_call_arguments.delta', { ...at, delta: 'hi' }],
          ]),
        ),
      /openai-responses stream: .*message item/,
    ],
    [
      'responses: response.failed without error',
      () =>
        readResponsesStream(
          responses([created, ['response.failed', { response: { ...RESP, status: 'failed' } }]]),
        ),
      /openai-responses stream: .*error/,
    ],
    [
      'responses: response.failed error without code',
      () =>
        readResponsesStream(
          responses([
            created,
            [
              'response.failed',
              { response: { ...RESP, status: 'failed', error: { message: 'busy' } } },
            ],
          ]),
        ),
      /openai-responses stream: .*error\.code/,
    ],
    [
      'responses json: error body without error.type',
      () => readResponsesJson({ error: { message: 'x', code: 'server_error' } }),
      /openai-responses json: .*error\.type/,
    ],
  ];
  it.each(broken)('%s', (_name, run, error) => {
    expect(run).toThrow(error);
  });

  it('the well-formed counterparts are accepted (the refusals are not blanket)', () => {
    expect(readAnthropicStream(anthropic())).toMatchObject({
      stopReason: 'end_turn',
      usage: { input: 5, output: 2 },
    });
    expect(readAnthropicStream(anthropicError())).toMatchObject({
      kind: 'error',
      type: 'overloaded_error',
    });
    expect(
      readChatStream(sse([[null, { error: { message: 'busy', type: 'server_error' } }]])),
    ).toMatchObject({ kind: 'error', type: 'server_error' });
    expect(
      readChatStream(
        sse([
          [null, chunk({ role: 'assistant', content: 'x' })],
          [null, chunk({}, 'stop', { usage: USAGE })],
          [null, '[DONE]'],
        ]),
      ),
    ).toMatchObject({ stopReason: 'stop', usage: { input: 3, output: 2 } });
    expect(
      readResponsesStream(
        responses([
          created,
          [
            'response.failed',
            {
              response: {
                ...RESP,
                status: 'failed',
                error: { code: 'server_error', message: 'busy' },
              },
            },
          ],
        ]),
      ),
    ).toMatchObject({ kind: 'error', midStream: true, type: 'server_error' });
    expect(
      readResponsesJson({
        error: { message: 'x', type: 'rate_limit_exceeded', param: null, code: null },
      }),
    ).toMatchObject({ kind: 'error', type: 'rate_limit_exceeded' });
  });
});
