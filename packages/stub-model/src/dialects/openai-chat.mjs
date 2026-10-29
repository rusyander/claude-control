/**
 * OpenAI Chat Completions (`POST …/chat/completions`) — провод Qwen Code, Goose,
 * OpenCode, Kimi Code, Continue, Aider. Поток — по справке «Streaming»: события без
 * имени, каждое `data:` — чанк `chat.completion.chunk`; первый несёт роль, вызов
 * инструмента — `tool_calls[i]` с id, именем и пустыми аргументами, следом чанк с
 * аргументами по тому же `index`; последний чанк — `finish_reason`; конец —
 * `data: [DONE]`.
 *
 * Расход: при `stream_options.include_usage` — отдельный чанк с пустым `choices` и
 * `usage` (как у OpenAI); без него — `usage` на чанке с `finish_reason`, как отдают
 * совместимые серверы (llama.cpp, vLLM): CLI без этой опции иначе не узнали бы токены.
 */
import { contentText } from './inspect.mjs';

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'invalid_request_error',
  402: 'insufficient_quota',
  403: 'permission_denied',
  404: 'not_found_error',
  429: 'rate_limit_exceeded',
  451: 'content_policy_violation',
  500: 'server_error',
  503: 'server_error',
};

const errorObject = (error) => {
  const type = error.type ?? ERROR_TYPES[error.status] ?? 'server_error';
  return { message: error.message, type, param: null, code: error.code ?? type };
};

const callId = (meta, part, index) => part.id ?? `call_stub_${meta.n}_${index}`;

function chunk(meta, delta, finish = null) {
  return {
    id: `chatcmpl-stub-${meta.n}`,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

/** `prompt_tokens` уже включает прочитанное из кеша — так считает OpenAI; кеш — в `prompt_tokens_details`. */
const usageOf = (meta) => ({
  prompt_tokens: meta.usage.input,
  completion_tokens: meta.usage.output,
  total_tokens: meta.usage.input + meta.usage.output,
  prompt_tokens_details: { cached_tokens: meta.usage.cached ?? 0 },
});

export const openaiChat = {
  id: 'openai-chat',
  parts: ['text', 'tool'],

  matches: (method, path) => method === 'POST' && /\/chat\/completions$/.test(path),

  inspect(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return {
      model: typeof body.model === 'string' ? body.model : undefined,
      stream: body.stream === true,
      includeUsage: body.stream_options?.include_usage === true,
      userTexts: messages.filter((m) => m?.role === 'user').map((m) => contentText(m.content)),
      tools: (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({
        name: tool?.function?.name ?? tool?.name ?? '',
        schema: tool?.function?.parameters ?? tool?.parameters,
      })),
      hasToolResult: messages.some((m) => m?.role === 'tool'),
    };
  },

  head(meta, parts) {
    return [
      ['', chunk(meta, { role: 'assistant', content: parts[0]?.kind === 'text' ? '' : null })],
    ];
  },

  body(meta, parts) {
    const frames = [];
    let call = 0;
    parts.forEach((part, index) => {
      if (part.kind === 'text') {
        for (const content of part.chunks) frames.push(['', chunk(meta, { content })]);
        return;
      }
      const at = call++;
      const head = {
        index: at,
        id: callId(meta, part, index),
        type: 'function',
        function: { name: part.name, arguments: '' },
      };
      frames.push(['', chunk(meta, { tool_calls: [head] })]);
      const args = JSON.stringify(part.args ?? {});
      frames.push([
        '',
        chunk(meta, { tool_calls: [{ index: at, function: { arguments: args } }] }),
      ]);
    });
    const finish = chunk(meta, {}, call > 0 ? 'tool_calls' : 'stop');
    // `extra` — на последнем чанке перед `[DONE]`, как llama-server кладёт `timings`.
    if (meta.includeUsage) {
      frames.push(['', finish]);
      frames.push(['', { ...chunk(meta, {}), choices: [], usage: usageOf(meta), ...meta.extra }]);
    } else frames.push(['', { ...finish, usage: usageOf(meta), ...meta.extra }]);
    frames.push(['', '[DONE]']);
    return frames;
  },

  /** Ошибка посреди потока: чанк `{error}` и обрыв без `[DONE]` — так её видят клиенты OpenAI. */
  failFrames(_meta, error) {
    return [['', { error: errorObject(error) }]];
  },

  json(meta, parts) {
    const text = parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('');
    const calls = parts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part.kind === 'tool')
      .map(({ part, index }) => ({
        id: callId(meta, part, index),
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.args ?? {}) },
      }));
    return {
      id: `chatcmpl-stub-${meta.n}`,
      object: 'chat.completion',
      created: meta.created,
      model: meta.model,
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || (calls.length ? null : ''),
            refusal: null,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
          logprobs: null,
          finish_reason: calls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: usageOf(meta),
      ...meta.extra,
    };
  },

  errorBody(error) {
    return { error: errorObject(error) };
  },

  windowHeaders: openaiWindowHeaders,
};

/**
 * Окно / предел частоты у OpenAI-совместимых — заголовки `x-ratelimit-*` (справка
 * «Rate limits»); 100 условных запросов, остаток — по доле использованного.
 */
export function openaiWindowHeaders(window, nowSeconds) {
  // `rejected` — окно исчерпано, как у Anthropic: остатка нет, какой бы ни была доля.
  const used = window.status === 'rejected' ? 1 : Math.min(1, Math.max(0, window.utilization ?? 0));
  const reset =
    window.resetsAt === undefined ? 60 : Math.max(0, Math.round(window.resetsAt - nowSeconds));
  return {
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-remaining-requests': String(Math.round(100 * (1 - used))),
    'x-ratelimit-reset-requests': `${reset}s`,
  };
}
