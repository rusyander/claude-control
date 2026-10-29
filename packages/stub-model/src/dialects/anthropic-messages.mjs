/**
 * Anthropic Messages API (`POST /v1/messages`) — как его разбирает Claude Code
 * (и любой клиент на SDK Anthropic). Поток — по документации «Streaming messages»:
 * `message_start` → `ping` → на каждый блок `content_block_start` /
 * `content_block_delta` / `content_block_stop` → `message_delta` (stop_reason,
 * usage) → `message_stop`; имя события совпадает с полем `type` данных. Без
 * `stream: true` — одно тело сообщения JSON.
 *
 * Окно подписки Claude Code читает не из тела, а из заголовков
 * `anthropic-ratelimit-unified-*` (имена сверены по строкам `claude.exe` 2.1.x) —
 * из них он сам пишет `rate_limit_event` в свой stream-json.
 */
import { contentText } from './inspect.mjs';

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  // 451 — отказ контура по политике (данные, регион); своего типа у Anthropic нет.
  451: 'permission_error',
  500: 'api_error',
  503: 'api_error',
  529: 'overloaded_error',
};

const errorType = (status, override) => override ?? ERROR_TYPES[status] ?? 'api_error';

const usageOf = (meta, outputTokens) => ({
  input_tokens: meta.usage.input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: meta.usage.cached ?? 0,
  output_tokens: outputTokens,
});

const hasCall = (parts) => parts.some((part) => part.kind === 'tool');

/** Блоки содержимого ответа в форме итогового сообщения. */
function blocks(meta, parts) {
  return parts.map((part, index) =>
    part.kind === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'tool_use',
          id: part.id ?? `toolu_stub_${meta.n}_${index}`,
          name: part.name,
          input: part.args ?? {},
        },
  );
}

export const anthropicMessages = {
  id: 'anthropic-messages',
  parts: ['text', 'tool'],

  matches: (method, path) => method === 'POST' && /\/messages$/.test(path),

  /** `count_tokens` Claude Code зовёт перед ходом: ответ — оценка, шаг сценария не тратится. */
  utility(method, path, raw) {
    if (method !== 'POST' || !/\/messages\/count_tokens$/.test(path)) return undefined;
    return { status: 200, body: { input_tokens: Math.max(1, Math.ceil(raw.length / 4)) } };
  },

  inspect(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return {
      model: typeof body.model === 'string' ? body.model : undefined,
      stream: body.stream === true,
      userTexts: messages.filter((m) => m?.role === 'user').map((m) => contentText(m.content)),
      tools: (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
        name: tool?.name ?? tool?.type ?? '',
        schema: tool?.input_schema,
      })),
      hasToolResult: messages.some(
        (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result'),
      ),
    };
  },

  head(meta) {
    return [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: `msg_stub_${meta.n}`,
            type: 'message',
            role: 'assistant',
            model: meta.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: usageOf(meta, 1),
          },
        },
      ],
      ['ping', { type: 'ping' }],
    ];
  },

  body(meta, parts) {
    const frames = [];
    blocks(meta, parts).forEach((block, index) => {
      const start = block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} };
      frames.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: start },
      ]);
      const deltas =
        block.type === 'text'
          ? parts[index].chunks.map((text) => ({ type: 'text_delta', text }))
          : [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }];
      for (const delta of deltas)
        frames.push(['content_block_delta', { type: 'content_block_delta', index, delta }]);
      frames.push(['content_block_stop', { type: 'content_block_stop', index }]);
    });
    frames.push([
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: hasCall(parts) ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: meta.usage.output },
        ...meta.extra,
      },
    ]);
    frames.push(['message_stop', { type: 'message_stop' }]);
    return frames;
  },

  /** Ошибка посреди потока — событие `error` (так API отдаёт перегрузку после начала ответа). */
  failFrames(_meta, error) {
    return [
      [
        'error',
        {
          type: 'error',
          error: { type: errorType(error.status, error.type), message: error.message },
        },
      ],
    ];
  },

  json(meta, parts) {
    return {
      id: `msg_stub_${meta.n}`,
      type: 'message',
      role: 'assistant',
      model: meta.model,
      content: blocks(meta, parts),
      stop_reason: hasCall(parts) ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: usageOf(meta, meta.usage.output),
      ...meta.extra,
    };
  },

  errorBody(error) {
    return {
      type: 'error',
      error: { type: errorType(error.status, error.type), message: error.message },
    };
  },

  /** Окно подписки → заголовки `anthropic-ratelimit-unified-*`. */
  windowHeaders(window) {
    const claim = window.claim ?? 'five_hour';
    const short = claim === 'seven_day' ? '7d' : '5h';
    const status = window.status ?? (window.utilization >= 1 ? 'rejected' : 'allowed');
    const headers = {
      'anthropic-ratelimit-unified-status': status,
      'anthropic-ratelimit-unified-representative-claim': claim,
      [`anthropic-ratelimit-unified-${short}-status`]: status,
    };
    if (window.resetsAt !== undefined) {
      headers['anthropic-ratelimit-unified-reset'] = String(window.resetsAt);
      headers[`anthropic-ratelimit-unified-${short}-reset`] = String(window.resetsAt);
    }
    if (window.utilization !== undefined)
      headers[`anthropic-ratelimit-unified-${short}-utilization`] = String(window.utilization);
    return headers;
  },
};
