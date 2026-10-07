import { Readable } from 'node:stream';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { serverText } from '../../../lib/server-texts.ts';

/**
 * Ручка `/v1/responses` шлюза (MAP D) — диалект, на котором говорит Codex.
 *
 * Контур и весь конвейер шлюза (правила, маска, прослойка инструментов, расход,
 * провод хуков) говорят на `chat/completions` и `messages`. Третий конвейер для
 * третьего диалекта разошёлся бы с двумя первыми молча, поэтому здесь — только
 * ПЕРЕВОД НА КРАЮ: запрос Responses становится запросом chat/completions, идёт
 * тем же путём, что и у любого клиента OpenAI, а ответ на выходе переводится
 * обратно в события Responses. Всё, что конвейер решил (отказ правила, маска,
 * вызов, снятый хуком), доезжает до Codex в его форме.
 *
 * Чего в chat/completions нет вовсе, честно выпадает и названо в `dropped`:
 * инструменты не-функции (`web_search`, пространства `namespace`), элементы
 * рассуждения (`reasoning` — у контура своё рассуждение, а зашифрованное чужое
 * переслать некуда), ссылки на сохранённые элементы. Сохранение на стороне
 * сервера (`store`, `previous_response_id`) шлюз не ведёт: Codex шлёт
 * `store: false` и всю историю в каждом запросе; запрос, который опирается на
 * `previous_response_id`, получает отказ, а не ответ без половины разговора.
 *
 * Форма событий сверена с тем, что принимает codex 0.160 (`tools/qa/stub-steer-model.mjs`,
 * живой прогон): `response.created` → `output_item.added` → дельты →
 * `output_item.done` → `response.completed` с `usage`.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Запрос, переведённый в chat/completions, и то, что перевести было нельзя. */
export interface BridgedRequest {
  chat: Json;
  /** Что выпало при переводе: типы инструментов и элементов. Для следа запроса. */
  dropped: string[];
  /** Инструменты `custom` (свободный текст вместо JSON) — ответ обязан вернуть их той же формой. */
  customTools: ReadonlySet<string>;
  model: string;
  stream: boolean;
}

/** Отказ перевода: текст для человека, форма — отказ OpenAI. */
export interface BridgeRefusal {
  refusal: string;
}

/** Текст частей содержимого: `input_text`, `output_text`, `text` и голая строка. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Содержимое сообщения для chat/completions. Строка — везде, где нет картинки:
 * часть контуров (vLLM с шаблоном Qwen, старые прокси) не принимает массив у
 * `system` и `assistant`, а строка понятна всем.
 */
function chatContent(content: unknown, dropped: string[]): unknown {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const hasImage = content.some((part) => isRecord(part) && part.type === 'input_image');
  if (!hasImage) return textOf(content);
  const parts: Json[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'input_image' && typeof part.image_url === 'string') {
      parts.push({ type: 'image_url', image_url: { url: part.image_url } });
    } else dropped.push(`content:${String(part.type)}`);
  }
  return parts;
}

const ROLE: Record<string, string> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  developer: 'system',
};

/** Перевод инструментов: функции — как есть, `custom` — функция с одним полем `input`. */
function chatTools(tools: unknown, dropped: string[], custom: Set<string>): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type === 'function' && typeof tool.name === 'string') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: isRecord(tool.parameters)
            ? tool.parameters
            : { type: 'object', properties: {} },
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        },
      });
    } else if (tool.type === 'custom' && typeof tool.name === 'string') {
      custom.add(tool.name);
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      });
    } else {
      dropped.push(`tool:${String(tool.type)}`);
    }
  }
  return out;
}

function chatToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isRecord(choice) && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/** Вывод инструмента — строкой: chat/completions другого не принимает у `tool`. */
function toolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return textOf(output);
  return output === undefined ? '' : JSON.stringify(output);
}

/**
 * Перевод запроса Responses в chat/completions. `undefined` — тело не запрос
 * Responses вовсе (нет `model` или `input`).
 */
export function responsesRequestToChat(body: unknown): BridgedRequest | BridgeRefusal | undefined {
  if (!isRecord(body) || typeof body.model !== 'string') return undefined;
  if (body.input === undefined) return undefined;
  if (typeof body.previous_response_id === 'string' && body.previous_response_id) {
    return { refusal: serverText('gateway-responses-previous-id') };
  }
  const dropped: string[] = [];
  const custom = new Set<string>();
  const tools = chatTools(body.tools, dropped, custom);
  const messages: Json[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const items: unknown[] =
    typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : [];
  if (Array.isArray(body.input)) items.push(...body.input);

  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      const role = ROLE[String(item.role)];
      if (!role) {
        dropped.push(`role:${String(item.role)}`);
        continue;
      }
      messages.push({ role, content: chatContent(item.content, dropped) });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const call = {
        id: String(item.call_id ?? item.id ?? ''),
        type: 'function',
        function: {
          name: String(item.name ?? ''),
          arguments:
            type === 'custom_tool_call'
              ? JSON.stringify({ input: String(item.input ?? '') })
              : String(item.arguments ?? '{}'),
        },
      };
      // Вызовы подряд — одно сообщение ассистента: так их пишет сама модель, и
      // часть контуров отвергает два ассистента подряд.
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        last.tool_calls = [...((last.tool_calls as Json[] | undefined) ?? []), call];
        if (last.content === '') last.content = null;
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: toolOutput(item.output),
      });
    } else {
      dropped.push(`item:${String(type)}`);
    }
  }

  const stream = body.stream === true;
  const chat: Json = { model: body.model, messages, stream };
  if (stream) chat.stream_options = { include_usage: true };
  if (tools.length > 0) {
    chat.tools = tools;
    const choice = chatToolChoice(body.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
    if (typeof body.parallel_tool_calls === 'boolean') {
      chat.parallel_tool_calls = body.parallel_tool_calls;
    }
  }
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : undefined;
  if (format?.type === 'json_schema' && isRecord(format.schema)) {
    chat.response_format = {
      type: 'json_schema',
      json_schema: {
        name: typeof format.name === 'string' ? format.name : 'output',
        schema: format.schema,
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      },
    };
  } else if (format?.type === 'json_object') {
    chat.response_format = { type: 'json_object' };
  }
  return { chat, dropped: [...new Set(dropped)], customTools: custom, model: body.model, stream };
}

/** Расход в форме Responses. */
function usageOf(usage: unknown): Json | undefined {
  if (!isRecord(usage)) return undefined;
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  const cached = isRecord(usage.prompt_tokens_details)
    ? Number(usage.prompt_tokens_details.cached_tokens ?? 0)
    : 0;
  const reasoning = isRecord(usage.completion_tokens_details)
    ? Number(usage.completion_tokens_details.reasoning_tokens ?? 0)
    : 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output),
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

interface OpenCall {
  index: number;
  outputIndex: number;
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Поток chat/completions → поток событий Responses. Кормится кусками текста
 * SSE как они пришли (строка может оборваться посреди), отдаёт текст SSE.
 */
export class ResponsesStreamBridge {
  readonly #model: string;
  readonly #custom: ReadonlySet<string>;
  readonly #id = `resp_${Date.now().toString(36)}`;
  readonly #createdAt = Math.floor(Date.now() / 1000);
  #buffer = '';
  #started = false;
  #closed = false;
  #output: Json[] = [];
  #text: { outputIndex: number; id: string; text: string } | undefined;
  #calls = new Map<number, OpenCall>();
  #usage: Json | undefined;
  #finish: string | undefined;

  constructor(model: string, customTools: ReadonlySet<string>) {
    this.#model = model;
    this.#custom = customTools;
  }

  #event(type: string, payload: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  }

  #response(status: string, extra: Json = {}): Json {
    return {
      id: this.#id,
      object: 'response',
      created_at: this.#createdAt,
      model: this.#model,
      status,
      output: this.#output,
      ...extra,
    };
  }

  #start(): string {
    if (this.#started) return '';
    this.#started = true;
    return (
      this.#event('response.created', { response: this.#response('in_progress') }) +
      this.#event('response.in_progress', { response: this.#response('in_progress') })
    );
  }

  #closeText(): string {
    const open = this.#text;
    if (!open) return '';
    this.#text = undefined;
    const part = { type: 'output_text', text: open.text, annotations: [] };
    const item = {
      type: 'message',
      id: open.id,
      role: 'assistant',
      status: 'completed',
      content: [part],
    };
    this.#output[open.outputIndex] = item;
    const at = { item_id: open.id, output_index: open.outputIndex, content_index: 0 };
    return (
      this.#event('response.output_text.done', { ...at, text: open.text }) +
      this.#event('response.content_part.done', { ...at, part }) +
      this.#event('response.output_item.done', { output_index: open.outputIndex, item })
    );
  }

  #callItem(call: OpenCall, status: string): Json {
    if (this.#custom.has(call.name)) {
      let input = call.arguments;
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (isRecord(parsed) && typeof parsed.input === 'string') input = parsed.input;
      } catch {
        // Не JSON — модель вернула текст прямо; он и есть ввод свободного инструмента.
      }
      return {
        type: 'custom_tool_call',
        id: call.id,
        call_id: call.callId,
        name: call.name,
        input,
        status,
      };
    }
    return {
      type: 'function_call',
      id: call.id,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status,
    };
  }

  #closeCalls(): string {
    let out = '';
    for (const call of [...this.#calls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      const item = this.#callItem(call, 'completed');
      this.#output[call.outputIndex] = item;
      if (item.type === 'function_call') {
        out += this.#event('response.function_call_arguments.done', {
          item_id: call.id,
          output_index: call.outputIndex,
          arguments: call.arguments,
        });
      }
      out += this.#event('response.output_item.done', { output_index: call.outputIndex, item });
    }
    this.#calls.clear();
    return out;
  }

  #onText(delta: string): string {
    let out = '';
    if (!this.#text) {
      const outputIndex = this.#output.length;
      const id = `msg_${this.#id}_${outputIndex}`;
      this.#text = { outputIndex, id, text: '' };
      const item = { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
      this.#output.push(item);
      out +=
        this.#event('response.output_item.added', { output_index: outputIndex, item }) +
        this.#event('response.content_part.added', {
          item_id: id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
    }
    this.#text.text += delta;
    return (
      out +
      this.#event('response.output_text.delta', {
        item_id: this.#text.id,
        output_index: this.#text.outputIndex,
        content_index: 0,
        delta,
      })
    );
  }

  #onToolCall(delta: Json): string {
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const fn = isRecord(delta.function) ? delta.function : {};
    let out = '';
    let call = this.#calls.get(index);
    if (!call) {
      out += this.#closeText();
      const outputIndex = this.#output.length;
      const callId =
        typeof delta.id === 'string' && delta.id ? delta.id : `call_${this.#id}_${index}`;
      call = {
        index,
        outputIndex,
        id: `fc_${this.#id}_${outputIndex}`,
        callId,
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: '',
      };
      this.#calls.set(index, call);
      const item = this.#callItem(call, 'in_progress');
      this.#output.push(item);
      out += this.#event('response.output_item.added', { output_index: outputIndex, item });
    } else if (typeof fn.name === 'string' && fn.name && !call.name) {
      call.name = fn.name;
    }
    if (typeof fn.arguments === 'string' && fn.arguments) {
      call.arguments += fn.arguments;
      if (!this.#custom.has(call.name)) {
        out += this.#event('response.function_call_arguments.delta', {
          item_id: call.id,
          output_index: call.outputIndex,
          delta: fn.arguments,
        });
      }
    }
    return out;
  }

  #fail(error: unknown): string {
    this.#closed = true;
    const body = isRecord(error) ? error : {};
    const failure = {
      code: typeof body.code === 'string' ? body.code : String(body.type ?? 'server_error'),
      message: typeof body.message === 'string' ? body.message : 'upstream error',
    };
    return (
      this.#start() +
      this.#event('response.failed', { response: this.#response('failed', { error: failure }) })
    );
  }

  #onChunk(chunk: unknown): string {
    if (!isRecord(chunk)) return '';
    if (chunk.error !== undefined) return this.#fail(chunk.error);
    let out = this.#start();
    const usage = usageOf(chunk.usage);
    if (usage) this.#usage = usage;
    const choice =
      Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) return out;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content) out += this.#onText(delta.content);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) if (isRecord(call)) out += this.#onToolCall(call);
    }
    if (typeof choice.finish_reason === 'string') this.#finish = choice.finish_reason;
    return out;
  }

  /** Кусок SSE chat/completions → события Responses. */
  push(text: string): string {
    if (this.#closed) return '';
    this.#buffer += text;
    return this.#drain();
  }

  /** Конец потока: закрыть открытые элементы и объявить итог. */
  end(): string {
    if (this.#closed) return '';
    this.#buffer += '\n';
    const out = this.#drain();
    return this.#closed ? out : out + this.#complete();
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

  #complete(): string {
    this.#closed = true;
    const out = this.#start() + this.#closeText() + this.#closeCalls();
    const incomplete = this.#finish === 'length';
    const response = this.#response(incomplete ? 'incomplete' : 'completed', {
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
    });
    return (
      out + this.#event(incomplete ? 'response.incomplete' : 'response.completed', { response })
    );
  }
}

/** Цельный ответ chat/completions → объект Responses (клиент просил не поток). */
export function chatCompletionToResponse(
  completion: unknown,
  model: string,
  customTools: ReadonlySet<string>,
): Json {
  const bridge = new ResponsesStreamBridge(model, customTools);
  const choice =
    isRecord(completion) && Array.isArray(completion.choices) && isRecord(completion.choices[0])
      ? completion.choices[0]
      : {};
  const message = isRecord(choice.message) ? choice.message : {};
  // Тот же переводчик, что у потока: цельное тело — это один кадр с дельтой,
  // и второй сборщик формы не нужен.
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
  const events = bridge.push(`data: ${JSON.stringify(frame)}\n`) + bridge.end();
  const last = events
    .trim()
    .split('\n\n')
    .at(-1)
    ?.split('\n')
    .find((line) => line.startsWith('data:'));
  const parsed = last ? (JSON.parse(last.slice(5)) as Json) : {};
  return isRecord(parsed.response) ? parsed.response : {};
}

/** Запрос для конвейера: то же, что пришло, но с телом chat/completions. */
export function bridgedRequest(original: IncomingMessage, body: Buffer): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  const headers = { ...original.headers };
  delete headers['content-length'];
  Object.assign(stream, { headers, method: original.method, url: original.url });
  return stream;
}

/**
 * Ответ для конвейера: всё, что конвейер пишет клиенту OpenAI, уходит Codex
 * событиями Responses. Повторяет ровно ту часть `ServerResponse`, которой
 * пользуется конвейер; события `close`/`drain` — настоящего соединения.
 *
 * Отказ (статус ≥ 400) уходит как есть: тело ошибки у Responses той же формы
 * `{ error: { message, type, code } }`, что у chat/completions.
 */
export function bridgedResponse(
  real: ServerResponse,
  request: Pick<BridgedRequest, 'model' | 'customTools'>,
): ServerResponse {
  let mode: 'stream' | 'json' | 'raw' = 'raw';
  let bridge: ResponsesStreamBridge | undefined;
  const json: string[] = [];
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
    writeHead(status: number, headers?: OutgoingHttpHeaders) {
      const type = String(headers?.['content-type'] ?? '');
      if (status === 200 && type.includes('event-stream')) {
        mode = 'stream';
        bridge = new ResponsesStreamBridge(request.model, request.customTools);
        real.writeHead(status, headers);
      } else if (status === 200 && type.includes('json')) {
        mode = 'json';
        real.writeHead(status, { ...headers, 'content-type': 'application/json' });
      } else {
        real.writeHead(status, headers);
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
      if (mode === 'json') {
        json.push(text);
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
      } else if (mode === 'json') {
        json.push(text);
        let completion: unknown;
        try {
          completion = JSON.parse(json.join(''));
        } catch {
          completion = undefined;
        }
        real.end(
          JSON.stringify(chatCompletionToResponse(completion, request.model, request.customTools)),
        );
      } else {
        real.end(text);
      }
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
