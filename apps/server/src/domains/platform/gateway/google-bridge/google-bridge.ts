import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { serverText } from '../../../../lib/server-texts/server-texts.ts';

/**
 * Ручки `…/models/<модель>:streamGenerateContent | :generateContent | :countTokens`
 * шлюза — диалект Gemini API, на котором говорит Gemini CLI.
 *
 * Тот же приём, что у Responses (`responses-bridge.ts`): ПЕРЕВОД НА КРАЮ. Запрос
 * Gemini становится запросом chat/completions и идёт общим конвейером (правила,
 * маска, прослойка инструментов, расход, провод хуков), а поток ответа на выходе
 * переводится в кадры Gemini. Третий конвейер разошёлся бы с первыми двумя молча.
 *
 * Форма сверена с тем, что шлёт и принимает gemini 0.62 (живая проба 07.10.2026,
 * `x7/gemini-probe`): `contents[{role, parts}]`, `systemInstruction.parts[].text`,
 * `tools[{functionDeclarations}]` с `parametersJsonSchema`, ответ — SSE
 * `data: {candidates:[{content:{role:'model',parts}, finishReason, index}], usageMetadata}`.
 * Вызов функции без `id` CLI исполняет, но с `id` сопоставляет ответ надёжнее —
 * шлюз отдаёт `id` вызова контура.
 *
 * Чего в chat/completions нет, честно выпадает и названо в `dropped`: инструменты
 * не-функции (`googleSearch`, `codeExecution`), части `fileData` (ссылка на файл
 * в облаке Google — переслать контуру нечего), бюджет рассуждения
 * (`thinkingConfig`: у контура своё рассуждение).
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Какую из трёх ручек позвали: метод — хвост пути после двоеточия. */
export type GoogleMethod = 'streamGenerateContent' | 'generateContent' | 'countTokens';

const GOOGLE_PATH = /\/models\/(.+):(streamGenerateContent|generateContent|countTokens)$/;

/** Модель и метод из пути; модель может содержать `/` (`Qwen/Qwen3-8B`). */
export function parseGooglePath(path: string): { model: string; method: GoogleMethod } | undefined {
  const clean = (path.split('?')[0] ?? path).replace(/\/+$/, '');
  const match = GOOGLE_PATH.exec(clean);
  if (!match?.[1] || !match[2]) return undefined;
  let model = match[1];
  try {
    model = decodeURIComponent(model);
  } catch {
    // Битая процент-последовательность: имя остаётся как пришло.
  }
  return { model, method: match[2] as GoogleMethod };
}

/** Запрос, переведённый в chat/completions, и то, что перевести было нельзя. */
export interface GoogleBridgedRequest {
  chat: Json;
  dropped: string[];
  model: string;
  stream: boolean;
}

export interface GoogleBridgeRefusal {
  refusal: string;
}

/**
 * Схема параметров в форме OpenAPI (`parameters`) пишет типы заглавными
 * (`OBJECT`, `STRING`) — JSON Schema их не знает. Переводим регистр рекурсивно;
 * `parametersJsonSchema` уже JSON Schema и идёт как есть.
 */
function lowerTypes(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(lowerTypes);
  if (!isRecord(schema)) return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] =
      key === 'type' && typeof value === 'string' ? value.toLowerCase() : lowerTypes(value);
  }
  return out;
}

function chatTools(tools: unknown, dropped: string[]): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    for (const key of Object.keys(tool)) {
      if (key !== 'functionDeclarations') dropped.push(`tool:${key}`);
    }
    if (!Array.isArray(tool.functionDeclarations)) continue;
    for (const fn of tool.functionDeclarations) {
      if (!isRecord(fn) || typeof fn.name !== 'string') continue;
      const parameters =
        fn.parametersJsonSchema ??
        (fn.parameters === undefined ? undefined : lowerTypes(fn.parameters));
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          parameters: parameters ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function chatToolChoice(config: unknown): unknown {
  const calling = isRecord(config) ? config.functionCallingConfig : undefined;
  if (!isRecord(calling)) return undefined;
  const mode = String(calling.mode ?? '').toUpperCase();
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY' || mode === 'VALIDATED') {
    const names = Array.isArray(calling.allowedFunctionNames) ? calling.allowedFunctionNames : [];
    return names.length === 1 && typeof names[0] === 'string'
      ? { type: 'function', function: { name: names[0] } }
      : 'required';
  }
  return mode === 'AUTO' ? 'auto' : undefined;
}

/** Ответ функции — строкой: у chat/completions содержимое `tool` только текст. */
function toolResult(response: unknown): string {
  if (isRecord(response) && Object.keys(response).length === 1 && 'output' in response) {
    const output = response.output;
    return typeof output === 'string' ? output : JSON.stringify(output);
  }
  return typeof response === 'string' ? response : JSON.stringify(response ?? {});
}

/**
 * Номера вызовов: у Gemini `id` у вызова необязателен, а chat/completions без него
 * ответ к вызову не привяжет. Вызов без `id` получает номер по порядку, ответ
 * без `id` — первый ещё не отвеченный номер вызова с тем же именем.
 */
class CallIds {
  #counter = 0;
  readonly #open = new Map<string, string[]>();

  forCall(name: string, id: unknown): string {
    const assigned = typeof id === 'string' && id ? id : `call_${(this.#counter += 1)}`;
    const queue = this.#open.get(name) ?? [];
    queue.push(assigned);
    this.#open.set(name, queue);
    return assigned;
  }

  forResponse(name: string, id: unknown): string {
    const queue = this.#open.get(name) ?? [];
    if (typeof id === 'string' && id) {
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      return id;
    }
    return queue.shift() ?? `call_${(this.#counter += 1)}`;
  }
}

function textOfParts(parts: unknown[]): string {
  return parts
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' && part.thought !== true ? part.text : '',
    )
    .filter(Boolean)
    .join('');
}

/** Одно сообщение `contents[]` → одно или несколько сообщений chat/completions. */
function chatMessages(content: Json, ids: CallIds, dropped: string[]): Json[] {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  if (content.role === 'model') {
    const calls: Json[] = [];
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.functionCall)) continue;
      const call = part.functionCall;
      const name = typeof call.name === 'string' ? call.name : '';
      calls.push({
        id: ids.forCall(name, call.id),
        type: 'function',
        function: { name, arguments: JSON.stringify(call.args ?? {}) },
      });
    }
    const text = textOfParts(parts);
    if (!text && calls.length === 0) return [];
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      },
    ];
  }

  // Ответы функций идут ПЕРВЫМИ: chat/completions требует, чтобы сообщения
  // `tool` шли сразу за ходом с вызовами.
  const out: Json[] = [];
  const user: Json[] = [];
  let hasImage = false;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (isRecord(part.functionResponse)) {
      const reply = part.functionResponse;
      const name = typeof reply.name === 'string' ? reply.name : '';
      out.push({
        role: 'tool',
        tool_call_id: ids.forResponse(name, reply.id),
        content: toolResult(reply.response),
      });
    } else if (typeof part.text === 'string') {
      if (part.thought !== true) user.push({ type: 'text', text: part.text });
    } else if (isRecord(part.inlineData) && typeof part.inlineData.data === 'string') {
      const mime =
        typeof part.inlineData.mimeType === 'string' ? part.inlineData.mimeType : 'image/png';
      if (mime.startsWith('image/')) {
        hasImage = true;
        user.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
        });
      } else dropped.push(`part:inlineData:${mime}`);
    } else {
      const kind = Object.keys(part)[0] ?? 'unknown';
      dropped.push(`part:${kind}`);
    }
  }
  if (user.length > 0) {
    // Строка — везде, где нет картинки: часть контуров массив не принимает.
    const text = user.map((part) => String(part.text ?? '')).join('');
    out.push({ role: 'user', content: hasImage ? user : text });
  }
  return out;
}

function generation(config: unknown, chat: Json, dropped: string[]): void {
  if (!isRecord(config)) return;
  if (typeof config.temperature === 'number') chat.temperature = config.temperature;
  if (typeof config.topP === 'number') chat.top_p = config.topP;
  if (typeof config.maxOutputTokens === 'number') chat.max_tokens = config.maxOutputTokens;
  if (Array.isArray(config.stopSequences) && config.stopSequences.length > 0) {
    chat.stop = config.stopSequences;
  }
  const schema = config.responseJsonSchema ?? config.responseSchema;
  if (schema !== undefined) {
    chat.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: config.responseJsonSchema === undefined ? lowerTypes(schema) : schema,
      },
    };
  } else if (config.responseMimeType === 'application/json') {
    chat.response_format = { type: 'json_object' };
  }
  if (config.thinkingConfig !== undefined) dropped.push('generationConfig:thinkingConfig');
}

/** Запрос Gemini → запрос chat/completions. `undefined` — тело не запрос. */
export function googleRequestToChat(
  body: unknown,
  model: string,
  stream: boolean,
): GoogleBridgedRequest | GoogleBridgeRefusal | undefined {
  if (!isRecord(body) || !Array.isArray(body.contents)) return undefined;
  const dropped: string[] = [];
  const messages: Json[] = [];
  const system = body.systemInstruction;
  const systemText =
    typeof system === 'string'
      ? system
      : isRecord(system) && Array.isArray(system.parts)
        ? textOfParts(system.parts)
        : '';
  if (systemText) messages.push({ role: 'system', content: systemText });
  const ids = new CallIds();
  for (const content of body.contents) {
    if (isRecord(content)) messages.push(...chatMessages(content, ids, dropped));
  }
  if (!messages.some((message) => message.role !== 'system')) {
    return { refusal: serverText('gateway-google-empty') };
  }
  const chat: Json = { model, messages, stream };
  if (stream) chat.stream_options = { include_usage: true };
  const tools = chatTools(body.tools, dropped);
  if (tools.length > 0) chat.tools = tools;
  const choice = chatToolChoice(body.toolConfig);
  if (choice !== undefined && tools.length > 0) chat.tool_choice = choice;
  generation(body.generationConfig, chat, dropped);
  return { chat, dropped, model, stream };
}

/**
 * Оценка для `:countTokens`: контур такой ручки не знает, а CLI зовёт её только
 * чтобы решить, не пора ли сжимать историю. Четыре знака на токен — та же грубая
 * мера, что у CLI, когда ручка недоступна.
 */
export function estimateGoogleTokens(body: unknown): number {
  const contents = isRecord(body) && Array.isArray(body.contents) ? body.contents : [];
  return Math.ceil(JSON.stringify(contents).length / 4);
}

function finishReasonOf(reason: string | undefined): string {
  if (reason === 'length') return 'MAX_TOKENS';
  if (reason === 'content_filter') return 'SAFETY';
  return 'STOP';
}

function usageOf(usage: unknown): Json | undefined {
  if (!isRecord(usage)) return undefined;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: completion,
    totalTokenCount: Number(usage.total_tokens ?? prompt + completion),
  };
}

const STATUS_NAMES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  402: 'RESOURCE_EXHAUSTED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  413: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  451: 'FAILED_PRECONDITION',
  499: 'CANCELLED',
  501: 'UNIMPLEMENTED',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/** Ошибка в форме Google API: `{ error: { code, message, status } }`. */
export function googleError(status: number, message: string): Json {
  return {
    error: {
      code: status,
      message,
      status: STATUS_NAMES[status] ?? (status >= 500 ? 'INTERNAL' : 'UNKNOWN'),
    },
  };
}

function messageOf(body: unknown): string {
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : 'upstream error';
}

interface OpenCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Поток chat/completions → поток Gemini. Текст уходит сразу, кусками; вызовы
 * функций копятся (их аргументы приходят дельтами) и уходят в последнем кадре
 * вместе с `finishReason` и расходом — CLI читает их целыми.
 */
export class GoogleStreamBridge {
  #buffer = '';
  #closed = false;
  #emitted = false;
  #finish: string | undefined;
  #usage: Json | undefined;
  readonly #calls = new Map<number, OpenCall>();

  #frame(payload: Json): string {
    this.#emitted = true;
    return `data: ${JSON.stringify(payload)}\r\n\r\n`;
  }

  #parts(parts: Json[]): string {
    return this.#frame({ candidates: [{ content: { role: 'model', parts }, index: 0 }] });
  }

  #onChunk(chunk: unknown): string {
    if (!isRecord(chunk)) return '';
    if (chunk.error !== undefined) {
      this.#closed = true;
      return this.#frame(googleError(500, messageOf(chunk)));
    }
    const usage = usageOf(chunk.usage);
    if (usage) this.#usage = usage;
    const choice =
      Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) return '';
    const delta = isRecord(choice.delta) ? choice.delta : {};
    let out = '';
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      out += this.#parts([{ text: delta.reasoning_content, thought: true }]);
    }
    if (typeof delta.content === 'string' && delta.content)
      out += this.#parts([{ text: delta.content }]);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) continue;
        const index = typeof call.index === 'number' ? call.index : this.#calls.size;
        const open = this.#calls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call.id === 'string' && call.id) open.id = call.id;
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.name === 'string' && fn.name) open.name = fn.name;
        if (typeof fn.arguments === 'string') open.args += fn.arguments;
        this.#calls.set(index, open);
      }
    }
    if (typeof choice.finish_reason === 'string') this.#finish = choice.finish_reason;
    return out;
  }

  #complete(): string {
    this.#closed = true;
    const calls = [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => {
        let args: unknown = {};
        try {
          args = call.args ? JSON.parse(call.args) : {};
        } catch {
          // Аргументы не JSON — контур так не отвечает; CLI получит пустые, а не обрыв.
        }
        return { functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args } };
      });
    // Пустого ответа CLI не принимает («пустой ответ модели»): без вызовов и текста
    // последний кадр несёт пустую текстовую часть.
    const parts = calls.length > 0 ? calls : this.#emitted ? [] : [{ text: '' }];
    return this.#frame({
      candidates: [
        { content: { role: 'model', parts }, finishReason: finishReasonOf(this.#finish), index: 0 },
      ],
      ...(this.#usage ? { usageMetadata: this.#usage } : {}),
    });
  }

  #drain(): string {
    let out = '';
    let index: number;
    while (!this.#closed && (index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        out += this.#complete();
        break;
      }
      try {
        out += this.#onChunk(JSON.parse(data));
      } catch {
        // Кадр не JSON — у chat/completions так не бывает; пропуск честнее падения потока.
      }
    }
    return out;
  }

  push(text: string): string {
    if (this.#closed) return '';
    this.#buffer += text;
    return this.#drain();
  }

  end(): string {
    if (this.#closed) return '';
    this.#buffer += '\n';
    const out = this.#drain();
    return this.#closed ? out : out + this.#complete();
  }
}

/** Цельный ответ chat/completions → ответ `:generateContent`. */
export function chatCompletionToGoogle(completion: unknown): Json {
  const choice =
    isRecord(completion) && Array.isArray(completion.choices) && isRecord(completion.choices[0])
      ? completion.choices[0]
      : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const frame = {
    choices: [
      {
        index: 0,
        delta: {
          ...(typeof message.content === 'string' ? { content: message.content } : {}),
          ...(Array.isArray(message.tool_calls)
            ? {
                tool_calls: (message.tool_calls as unknown[]).map((call, index) =>
                  isRecord(call) ? { index, ...call } : call,
                ),
              }
            : {}),
        },
        finish_reason: choice.finish_reason ?? 'stop',
      },
    ],
    ...(isRecord(completion) && completion.usage ? { usage: completion.usage } : {}),
  };
  // Тот же переводчик, что у потока: цельное тело — один кадр. Части всех кадров
  // склеиваются в один кандидат.
  const bridge = new GoogleStreamBridge();
  const frames = (bridge.push(`data: ${JSON.stringify(frame)}\n`) + bridge.end())
    .split('\r\n\r\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Json);
  const parts: unknown[] = [];
  let last: Json = {};
  for (const item of frames) {
    const candidate =
      Array.isArray(item.candidates) && isRecord(item.candidates[0]) ? item.candidates[0] : {};
    const content = isRecord(candidate.content) ? candidate.content : {};
    if (Array.isArray(content.parts)) parts.push(...content.parts);
    last = item;
  }
  const lastCandidate =
    Array.isArray(last.candidates) && isRecord(last.candidates[0]) ? last.candidates[0] : {};
  return {
    candidates: [
      {
        content: { role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] },
        finishReason: lastCandidate.finishReason ?? 'STOP',
        index: 0,
      },
    ],
    ...(last.usageMetadata ? { usageMetadata: last.usageMetadata } : {}),
  };
}

/**
 * Ответ для конвейера: всё, что конвейер пишет клиенту OpenAI, уходит Gemini в
 * его форме — поток кадрами Gemini, цельное тело ответом `:generateContent`,
 * отказ (статус ≥ 400) — ошибкой Google API с тем же кодом. Отказ переводится и
 * у ранних проверок самой ручки (тело не JSON, слишком большое): они пишут в
 * этот же ответ.
 */
export function googleResponse(real: ServerResponse): ServerResponse {
  let mode: 'stream' | 'json' | 'error' | 'raw' = 'raw';
  let status = 200;
  let bridge: GoogleStreamBridge | undefined;
  const buffered: string[] = [];
  let ended = false;

  const wrapper = {
    get destroyed() {
      return real.destroyed;
    },
    get headersSent() {
      return real.headersSent;
    },
    get writableEnded() {
      return ended || real.writableEnded;
    },
    get writableFinished() {
      return real.writableFinished;
    },
    writeHead(code: number, headers?: OutgoingHttpHeaders) {
      status = code;
      const type = String(headers?.['content-type'] ?? '');
      if (code === 200 && type.includes('event-stream')) {
        mode = 'stream';
        bridge = new GoogleStreamBridge();
        real.writeHead(code, headers);
      } else if (code === 200 && type.includes('json')) {
        mode = 'json';
        real.writeHead(code, { ...headers, 'content-type': 'application/json' });
      } else if (code >= 400) {
        mode = 'error';
        real.writeHead(code, { ...headers, 'content-type': 'application/json' });
      } else {
        real.writeHead(code, headers);
      }
      return wrapper;
    },
    flushHeaders() {
      real.flushHeaders();
    },
    write(chunk: unknown) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (mode === 'stream' && bridge) {
        const out = bridge.push(text);
        return out ? real.write(out) : true;
      }
      if (mode === 'json' || mode === 'error') {
        buffered.push(text);
        return true;
      }
      return real.write(text);
    },
    end(chunk?: unknown) {
      if (ended) return wrapper;
      const text = chunk === undefined || chunk === null ? '' : String(chunk);
      ended = true;
      if (mode === 'stream' && bridge) {
        real.end(bridge.push(text) + bridge.end());
        return wrapper;
      }
      if (mode === 'json' || mode === 'error') {
        buffered.push(text);
        let body: unknown;
        try {
          body = JSON.parse(buffered.join(''));
        } catch {
          body = undefined;
        }
        real.end(
          JSON.stringify(
            mode === 'json' ? chatCompletionToGoogle(body) : googleError(status, messageOf(body)),
          ),
        );
        return wrapper;
      }
      real.end(text);
      return wrapper;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      real.on(event, listener);
      return wrapper;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      real.once(event, listener);
      return wrapper;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      real.off(event, listener);
      return wrapper;
    },
  };
  return wrapper as unknown as ServerResponse;
}
