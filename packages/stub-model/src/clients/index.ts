/**
 * Клиенты-оракулы по протоколам: как CLI этого протокола шлёт запрос и как разбирает
 * ответ. `Record<DialectId, …>` — протокол без клиента не соберётся (`tsc`), а тест
 * покрытия возможностей проверяет то же во время прогона.
 */
import type { DialectId } from '../index.d.mts';
import { readAnthropicJson, readAnthropicStream } from './anthropic.ts';
import { readChatJson, readChatStream } from './openai-chat.ts';
import { readResponsesJson, readResponsesStream } from './openai-responses.ts';
import type { Reply } from './reply.ts';

export type { Reply, ReplyPart } from './reply.ts';
export { parseSse } from './sse.ts';

export interface RequestOptions {
  stream: boolean;
  text: string;
  /** Объявить один инструмент оболочки (как делает CLI). */
  tool?: boolean;
  /** В истории есть результат инструмента. */
  toolResult?: boolean;
  includeUsage?: boolean;
}

export interface Client {
  path: string;
  headers: Record<string, string>;
  request(options: RequestOptions): Record<string, unknown>;
  stream(text: string): Reply;
  json(body: Record<string, unknown>): Reply;
}

const SHELL_SCHEMA = {
  type: 'object',
  properties: { command: { type: 'string' } },
  required: ['command'],
};

export const CLIENTS: Record<DialectId, Client> = {
  'anthropic-messages': {
    path: '/v1/messages?beta=true',
    headers: { 'x-api-key': 'sk-ant-test-SECRET-VALUE', 'anthropic-version': '2023-06-01' },
    request: (o) => ({
      model: 'claude-test',
      max_tokens: 64,
      stream: o.stream,
      ...(o.tool ? { tools: [{ name: 'Bash', input_schema: SHELL_SCHEMA }] } : {}),
      messages: [
        { role: 'user', content: [{ type: 'text', text: o.text }] },
        ...(o.toolResult
          ? [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
              },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
              },
            ]
          : []),
      ],
    }),
    stream: readAnthropicStream,
    json: readAnthropicJson,
  },
  'openai-chat': {
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-test-SECRET-VALUE' },
    request: (o) => ({
      model: 'gpt-test',
      stream: o.stream,
      ...(o.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(o.tool
        ? { tools: [{ type: 'function', function: { name: 'shell', parameters: SHELL_SCHEMA } }] }
        : {}),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: o.text },
        ...(o.toolResult
          ? [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } },
                ],
              },
              { role: 'tool', tool_call_id: 'c1', content: 'ok' },
            ]
          : []),
      ],
    }),
    stream: readChatStream,
    json: readChatJson,
  },
  'openai-responses': {
    path: '/v1/responses',
    headers: { authorization: 'Bearer sk-test-SECRET-VALUE' },
    request: (o) => ({
      model: 'gpt-test',
      stream: o.stream,
      instructions: 'sys',
      ...(o.tool
        ? {
            tools: [
              { type: 'function', name: 'shell', parameters: SHELL_SCHEMA },
              { type: 'custom', name: 'apply_patch' },
            ],
          }
        : {}),
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: o.text }] },
        ...(o.toolResult
          ? [
              { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
              { type: 'function_call_output', call_id: 'c1', output: 'ok' },
            ]
          : []),
      ],
    }),
    stream: readResponsesStream,
    json: readResponsesJson,
  },
};
