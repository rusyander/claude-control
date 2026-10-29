/**
 * OpenAI Responses API (`POST …/responses`) — провод Codex. Поток — по справке
 * «Streaming responses»: у каждого события имя = поле `type` и растущий
 * `sequence_number`; `response.created` → `response.in_progress` → на каждый элемент
 * вывода `response.output_item.added` … `response.output_item.done` (текст — через
 * `content_part.added` / `output_text.delta` / `output_text.done` / `content_part.done`,
 * вызов функции — `function_call_arguments.delta` / `.done`, свободный инструмент
 * Codex (apply_patch) — `custom_tool_call_input.delta` / `.done`) →
 * `response.completed` с полным `output` и `usage`. Ошибка посреди потока —
 * `response.failed`. Без `stream: true` — объект ответа JSON.
 */
import { contentText } from './inspect.mjs';
import { openaiWindowHeaders } from './openai-chat.mjs';

const ERROR_CODES = {
  400: 'invalid_request_error',
  401: 'invalid_api_key',
  402: 'insufficient_quota',
  403: 'permission_denied',
  404: 'not_found',
  429: 'rate_limit_exceeded',
  451: 'content_policy_violation',
  500: 'server_error',
  503: 'server_is_overloaded',
};

const codeOf = (error) => error.code ?? ERROR_CODES[error.status] ?? 'server_error';

const isUserMessage = (item) =>
  item?.role === 'user' && (item.type === undefined || item.type === 'message');

/** Элемент вывода в законченном виде (`output_item.done`, `response.completed`). */
function doneItem(meta, part, index) {
  const suffix = `${meta.n}_${index}`;
  if (part.kind === 'text')
    return {
      id: `msg_stub_${suffix}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: part.text, annotations: [], logprobs: [] }],
    };
  if (part.kind === 'tool')
    return {
      id: `fc_stub_${suffix}`,
      type: 'function_call',
      status: 'completed',
      call_id: part.id ?? `call_stub_${suffix}`,
      name: part.name,
      arguments: JSON.stringify(part.args ?? {}),
    };
  return {
    id: `ctc_stub_${suffix}`,
    type: 'custom_tool_call',
    status: 'completed',
    call_id: part.id ?? `call_stub_${suffix}`,
    name: part.name,
    input: part.input,
  };
}

function response(meta, status, output, extra = {}) {
  return {
    id: `resp_stub_${meta.n}`,
    object: 'response',
    created_at: meta.created,
    status,
    model: meta.model,
    output,
    usage:
      status === 'completed'
        ? {
            input_tokens: meta.usage.input,
            input_tokens_details: { cached_tokens: meta.usage.cached ?? 0 },
            output_tokens: meta.usage.output,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: meta.usage.input + meta.usage.output,
          }
        : null,
    ...extra,
  };
}

/** Событие с именем = `type` и следующим `sequence_number` ответа. */
const event = (meta, type, data) => [type, { type, sequence_number: meta.seq++, ...data }];

/** События одного элемента вывода между `added` и `done`. */
function itemFrames(meta, part, index) {
  const done = doneItem(meta, part, index);
  const at = { item_id: done.id, output_index: index };
  if (part.kind === 'text') {
    const empty = { ...done, status: 'in_progress', content: [] };
    const textPart = done.content[0];
    return [
      event(meta, 'response.output_item.added', { output_index: index, item: empty }),
      event(meta, 'response.content_part.added', {
        ...at,
        content_index: 0,
        part: { ...textPart, text: '' },
      }),
      ...part.chunks.map((delta) =>
        event(meta, 'response.output_text.delta', {
          ...at,
          content_index: 0,
          delta,
          logprobs: [],
        }),
      ),
      event(meta, 'response.output_text.done', {
        ...at,
        content_index: 0,
        text: part.text,
        logprobs: [],
      }),
      event(meta, 'response.content_part.done', { ...at, content_index: 0, part: textPart }),
      event(meta, 'response.output_item.done', { output_index: index, item: done }),
    ];
  }
  const field = part.kind === 'tool' ? 'arguments' : 'input';
  const prefix =
    part.kind === 'tool' ? 'response.function_call_arguments' : 'response.custom_tool_call_input';
  return [
    event(meta, 'response.output_item.added', {
      output_index: index,
      item: { ...done, status: 'in_progress', [field]: '' },
    }),
    event(meta, `${prefix}.delta`, { ...at, delta: done[field] }),
    event(meta, `${prefix}.done`, { ...at, [field]: done[field] }),
    event(meta, 'response.output_item.done', { output_index: index, item: done }),
  ];
}

export const openaiResponses = {
  id: 'openai-responses',
  parts: ['text', 'tool', 'custom'],

  matches: (method, path) => method === 'POST' && /\/responses$/.test(path),

  inspect(body) {
    const input = body.input;
    const items = Array.isArray(input) ? input : [];
    return {
      model: typeof body.model === 'string' ? body.model : undefined,
      stream: body.stream === true,
      userTexts:
        typeof input === 'string'
          ? [input]
          : items.filter(isUserMessage).map((item) => contentText(item.content)),
      tools: (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
        name: tool?.name ?? tool?.type ?? '',
        schema: tool?.parameters,
        ...(tool?.type === 'custom' ? { custom: true } : {}),
      })),
      hasToolResult: items.some(
        (item) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output',
      ),
    };
  },

  head(meta) {
    meta.seq = 0;
    const started = response(meta, 'in_progress', []);
    return [
      event(meta, 'response.created', { response: started }),
      event(meta, 'response.in_progress', { response: started }),
    ];
  },

  body(meta, parts) {
    const frames = parts.flatMap((part, index) => itemFrames(meta, part, index));
    const output = parts.map((part, index) => doneItem(meta, part, index));
    frames.push(
      event(meta, 'response.completed', {
        response: response(meta, 'completed', output, meta.extra),
      }),
    );
    return frames;
  },

  failFrames(meta, error) {
    const failed = response(meta, 'failed', [], {
      error: { code: codeOf(error), message: error.message },
    });
    return [event(meta, 'response.failed', { response: failed })];
  },

  json(meta, parts) {
    return response(
      meta,
      'completed',
      parts.map((part, index) => doneItem(meta, part, index)),
      meta.extra,
    );
  },

  errorBody(error) {
    return {
      error: {
        message: error.message,
        type: error.type ?? codeOf(error),
        param: null,
        code: codeOf(error),
      },
    };
  },

  windowHeaders: openaiWindowHeaders,
};
