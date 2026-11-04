import { describe, it, expect } from 'vitest';
import {
  chatCompletionToResponse,
  responsesRequestToChat,
  ResponsesStreamBridge,
  type BridgedRequest,
} from './responses-bridge.ts';

/**
 * Перевод на краю шлюза: Responses (Codex) ⇄ chat/completions (MAP D).
 *
 * Запрос взят формы, которую codex 0.160 шлёт на самом деле (снят живым
 * перехватом `.agent/tmp/0710/d-probe/cap1`): `instructions`, сообщение
 * `developer`, `function_call` и `function_call_output` в истории, инструменты
 * функций вперемешку с `namespace` и `web_search`.
 */

function bridged(body: unknown): BridgedRequest {
  const result = responsesRequestToChat(body);
  if (!result || 'refusal' in result) throw new Error(`не переведён: ${JSON.stringify(result)}`);
  return result;
}

/** События из текста SSE: тип и данные. */
function events(sse: string): { type: string; data: Record<string, unknown> }[] {
  return sse
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>;
      return { type, data };
    });
}

const CODEX_REQUEST = {
  model: 'qwen3',
  instructions: 'You are Codex.',
  input: [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'sandbox: none' }],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run echo' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'xxx', summary: [] },
    {
      type: 'function_call',
      id: 'fc_1',
      name: 'exec_command',
      arguments: '{"cmd":"echo hi"}',
      call_id: 'call_1',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'hi' },
  ],
  tools: [
    {
      type: 'function',
      name: 'exec_command',
      description: 'Runs a command',
      strict: false,
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    },
    { type: 'namespace', name: 'multi_agent_v1', tools: [] },
    { type: 'web_search' },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { summary: 'auto' },
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'k',
  client_metadata: { a: 'b' },
};

describe('запрос Responses → chat/completions', () => {
  it('история Codex становится сообщениями chat: system, user, вызов ассистента, ответ tool', () => {
    const { chat, dropped } = bridged(CODEX_REQUEST);
    expect(chat.messages).toEqual([
      { role: 'system', content: 'You are Codex.' },
      { role: 'system', content: 'sandbox: none' },
      { role: 'user', content: 'run echo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"echo hi"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'hi' },
    ]);
    expect(chat.stream).toBe(true);
    expect(chat.stream_options).toEqual({ include_usage: true });
    expect(dropped.sort()).toEqual(['item:reasoning', 'tool:namespace', 'tool:web_search']);
  });

  it('инструменты — только функции, в форме chat; служебные поля Responses не уезжают в контур', () => {
    const { chat } = bridged(CODEX_REQUEST);
    expect(chat.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'Runs a command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
          strict: false,
        },
      },
    ]);
    expect(chat.tool_choice).toBe('auto');
    expect(chat.parallel_tool_calls).toBe(true);
    for (const key of [
      'reasoning',
      'store',
      'include',
      'prompt_cache_key',
      'client_metadata',
      'input',
      'instructions',
    ]) {
      expect(chat).not.toHaveProperty(key);
    }
  });

  it('строка вместо списка, max_output_tokens, json_schema, картинка', () => {
    expect(bridged({ model: 'm', input: 'hi' }).chat.messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
    const { chat } = bridged({
      model: 'm',
      max_output_tokens: 50,
      text: {
        format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true },
      },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          ],
        },
      ],
    });
    expect(chat.max_tokens).toBe(50);
    expect(chat.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
    expect(chat.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ]);
  });

  it('свободный инструмент custom: функция с полем input, вызов в истории — тот же input', () => {
    const { chat, customTools } = bridged({
      model: 'm',
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch' }],
      input: [
        { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' },
      ],
    });
    expect(customTools.has('apply_patch')).toBe(true);
    expect((chat.messages as { tool_calls: unknown }[])[0]?.tool_calls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
      },
    ]);
  });

  it('previous_response_id — отказ, а не ответ без половины разговора; не Responses — undefined', () => {
    expect(
      responsesRequestToChat({ model: 'm', input: 'x', previous_response_id: 'resp_1' }),
    ).toHaveProperty('refusal');
    expect(responsesRequestToChat({ model: 'm', messages: [] })).toBeUndefined();
    expect(responsesRequestToChat('x')).toBeUndefined();
  });
});

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

describe('поток chat/completions → события Responses', () => {
  it('текст: created → item.added → дельты → done → completed с расходом', () => {
    const bridge = new ResponsesStreamBridge('qwen3', new Set());
    // Кадр, разрезанный посреди строки, собирается.
    const first = chunk({ role: 'assistant', content: 'При' });
    let out = bridge.push(first.slice(0, 20));
    out += bridge.push(first.slice(20));
    out += bridge.push(chunk({ content: 'вет' }));
    out += bridge.push(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`,
    );
    out += bridge.push('data: [DONE]\n\n');
    out += bridge.end();
    const list = events(out);
    expect(list.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(
      list.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta),
    ).toEqual(['При', 'вет']);
    const done = list.at(-1)?.data.response as Record<string, unknown>;
    expect(done.status).toBe('completed');
    expect(done.output).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Привет', annotations: [] }],
      }),
    ]);
    expect(done.usage).toMatchObject({ input_tokens: 7, output_tokens: 2, total_tokens: 9 });
  });

  it('вызов инструмента: аргументы кусками собираются, call_id — модели, текст до вызова закрыт', () => {
    const bridge = new ResponsesStreamBridge('m', new Set());
    let out = bridge.push(chunk({ content: 'Сейчас.' }));
    out += bridge.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_9',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":' },
          },
        ],
      }),
    );
    out += bridge.push(
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] }),
    );
    out += bridge.push('data: [DONE]\n\n');
    const list = events(out);
    const done = list.filter((e) => e.type === 'response.output_item.done').map((e) => e.data.item);
    expect(done).toEqual([
      expect.objectContaining({ type: 'message' }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_9',
        name: 'exec_command',
        arguments: '{"cmd":"echo hi"}',
        status: 'completed',
      }),
    ]);
    // Текст закрыт ДО того, как открылся вызов: у Codex элементы идут по одному.
    const types = list.map((e) => e.type);
    expect(types.indexOf('response.output_text.done')).toBeLessThan(
      types.lastIndexOf('response.output_item.added'),
    );
    expect(list.at(-1)?.type).toBe('response.completed');
  });

  it('свободный инструмент возвращается custom_tool_call с input, а не function_call', () => {
    const bridge = new ResponsesStreamBridge('m', new Set(['apply_patch']));
    const out =
      bridge.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'c',
              function: { name: 'apply_patch', arguments: '{"input":"*** Begin"}' },
            },
          ],
        }),
      ) + bridge.end();
    const item = events(out).find((e) => e.type === 'response.output_item.done')?.data.item;
    expect(item).toMatchObject({ type: 'custom_tool_call', call_id: 'c', input: '*** Begin' });
  });

  it('ошибка в потоке (кадр error шлюза) → response.failed, дальше ни кадра', () => {
    const bridge = new ResponsesStreamBridge('m', new Set());
    let out = bridge.push(chunk({ content: 'на' }));
    out += bridge.push(
      `data: ${JSON.stringify({ error: { message: 'AgentDeck: правило', type: 'content_policy_violation', code: 'content_policy_violation' } })}\n\n`,
    );
    out += bridge.push(chunk({ content: 'после' }));
    out += bridge.push('data: [DONE]\n\n');
    out += bridge.end();
    const list = events(out);
    expect(list.at(-1)?.type).toBe('response.failed');
    expect((list.at(-1)?.data.response as { error: unknown }).error).toEqual({
      code: 'content_policy_violation',
      message: 'AgentDeck: правило',
    });
    expect(out).not.toContain('после');
    expect(list.some((e) => e.type === 'response.completed')).toBe(false);
  });

  it('обрыв по длине — response.incomplete с причиной', () => {
    const bridge = new ResponsesStreamBridge('m', new Set());
    const out =
      bridge.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] })}\n\n`,
      ) + bridge.end();
    const last = events(out).at(-1);
    expect(last?.type).toBe('response.incomplete');
    expect(last?.data.response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
  });
});

describe('цельный ответ chat/completions → объект Responses', () => {
  it('текст и вызов в одном ответе, расход', () => {
    const response = chatCompletionToResponse(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
      'm',
      new Set(),
    );
    expect(response.status).toBe('completed');
    expect(response.output).toEqual([
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_1',
        name: 'f',
        arguments: '{}',
      }),
    ]);
    expect(response.usage).toMatchObject({ input_tokens: 3, total_tokens: 4 });
  });
});
