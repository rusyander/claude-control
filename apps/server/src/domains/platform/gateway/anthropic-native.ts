import type { IncomingMessage } from 'node:http';
import type { Platform } from '@agentdeck/contracts';
import type { PlatformDriver } from '../drivers/driver.ts';
import { errorBody } from './dialect.ts';

/**
 * Платформа, говорящая на диалекте Anthropic сама (DRV-07): манифест объявил
 * ручку `anthropic.messages`, и клиент Anthropic идёт к ней БЕЗ моста.
 *
 * Мост в OpenAI теряет размышления, метки кэша и подписанные блоки — у контура
 * без родной ручки иначе нельзя, а у шлюза с ней (LiteLLM `/v1/messages`, прокси
 * Bedrock, корпоративный шлюз Anthropic-вида) потеря была бы нашей, а не его.
 * Тело уходит как есть; шлюз при этом остаётся шлюзом: ключ контура, правила
 * контура, защита данных, расход и след — те же, что на мосту.
 *
 * Здесь — только то, что знает про сам диалект: какие заголовки протокола
 * пропускаются, что снимается с тела и как из потока читаются расход, вызовы,
 * ошибка и досказанность. Отправку и ответ клиенту ведёт конвейер.
 */

/**
 * Путь родной ручки, если клиент Anthropic идёт к ней, иначе `undefined` — мост.
 * Одно решение на конвейер и на подпись `dialect-bridge` в состоянии шлюза.
 *
 * Включённая человеком прослойка сильнее манифеста: её протокол собран под мост,
 * и «инструменты этому шлюзу — текстом» означает ровно мост. Инструменты самой
 * платформы прослойку и так гасят (`chooseToolRoute`), поэтому с ними ручка
 * остаётся родной.
 */
export function nativeMessagesPath(
  platform: Pick<Platform, 'toolShim' | 'rules'>,
  driver: Pick<PlatformDriver, 'anthropic'>,
): string | undefined {
  if (!driver.anthropic) return undefined;
  const shim = platform.toolShim && platform.rules.platform.platformTools.length === 0;
  return shim ? undefined : driver.anthropic.messages;
}

/** Версия протокола, без которой ручка Anthropic-вида не отвечает вовсе. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Заголовки клиента, которые уходят наверх. Ровно два, и оба — протокол, а не
 * доступ: без `anthropic-beta` платформа не включит размышления вперемешку с
 * вызовами и длинное окно, о которых клиент попросил. Ключ клиента не уходит
 * никогда (`x-api-key` у CLI — заглушка, ключ подставляет шлюз).
 */
const PROTOCOL_HEADERS = ['anthropic-version', 'anthropic-beta'] as const;

/** Печатный ASCII без переводов строк: чужое значение не разорвёт заголовок. */
const HEADER_VALUE = /^[\x21-\x7e][\x20-\x7e]{0,511}$/;

export function nativeHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  for (const name of PROTOCOL_HEADERS) {
    const raw = request.headers[name];
    const value = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).trim();
    if (HEADER_VALUE.test(value)) headers[name] = value;
  }
  return headers;
}

/**
 * Тело наверх. Снимается одно: клиентские инструменты там, где включены
 * инструменты САМОЙ платформы (Т7) — два набора на один ход взаимно
 * исключаются так же, как на мосту, и снятое названо потерей.
 */
export function nativeRequestBody(
  body: Record<string, unknown>,
  platformTools: boolean,
): { body: Record<string, unknown>; lost: string[] } {
  if (!platformTools) return { body, lost: [] };
  const lost = ['tools', 'tool_choice'].filter((field) => body[field] !== undefined);
  if (lost.length === 0) return { body, lost };
  const next = { ...body };
  for (const field of lost) delete next[field];
  return { body: next, lost };
}

/** Что конвейер записывает в учёт и след. */
export interface NativeFacts {
  /** Вход вместе с прочитанным и записанным кэшем: это токены, которые платформа списала. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Блоков `tool_use` в ответе. */
  toolCalls: number;
  upstreamError?: { code: string; message: string };
  /** Ответ досказан: в потоке пришёл `message_stop`, цельным телом — сообщение. */
  complete: boolean;
}

interface Tokens {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

const USAGE_FIELDS: Array<[keyof Tokens, string]> = [
  ['input', 'input_tokens'],
  ['cacheRead', 'cache_read_input_tokens'],
  ['cacheCreation', 'cache_creation_input_tokens'],
  ['output', 'output_tokens'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Счётчики — последнее НЕНУЛЕВОЕ значение: `message_start` несёт вход и
 * заглушку выхода, `message_delta` — итог выхода, а у части прокси ещё и
 * нулевой вход, который затёр бы настоящий.
 */
function readUsage(tokens: Tokens, usage: unknown): void {
  if (!isRecord(usage)) return;
  for (const [ours, theirs] of USAGE_FIELDS) {
    const value = usage[theirs];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) tokens[ours] = value;
  }
}

function errorOf(payload: Record<string, unknown>): { code: string; message: string } {
  const error = isRecord(payload.error) ? payload.error : {};
  return {
    code: typeof error.type === 'string' && error.type ? error.type : 'api_error',
    message: typeof error.message === 'string' ? error.message.slice(0, 300) : '',
  };
}

function factsOf(
  tokens: Tokens,
  rest: Omit<NativeFacts, keyof Tokens | 'promptTokens' | 'completionTokens' | 'totalTokens'>,
): NativeFacts {
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return {
    promptTokens,
    completionTokens: tokens.output,
    totalTokens: promptTokens + tokens.output,
    ...rest,
  };
}

/** Поток читается сбоку: байты клиенту идут как пришли, здесь только факты. */
export class AnthropicStreamMeter {
  #buffer = '';
  readonly #tokens: Tokens = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  #toolCalls = 0;
  #error?: { code: string; message: string };
  #complete = false;

  push(chunk: string): void {
    this.#buffer += chunk;
    const frames = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = frames.pop() ?? '';
    for (const frame of frames) this.#frame(frame);
  }

  end(): void {
    if (this.#buffer.trim()) this.#frame(this.#buffer);
    this.#buffer = '';
  }

  get facts(): NativeFacts {
    return factsOf(this.#tokens, {
      toolCalls: this.#toolCalls,
      complete: this.#complete,
      ...(this.#error ? { upstreamError: this.#error } : {}),
    });
  }

  #frame(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const payload = parse(data);
    if (!isRecord(payload)) return;

    switch (payload.type) {
      case 'message_start':
        readUsage(this.#tokens, isRecord(payload.message) ? payload.message.usage : undefined);
        break;
      case 'message_delta':
        readUsage(this.#tokens, payload.usage);
        break;
      case 'content_block_start':
        if (isRecord(payload.content_block) && payload.content_block.type === 'tool_use') {
          this.#toolCalls += 1;
        }
        break;
      case 'message_stop':
        this.#complete = true;
        break;
      case 'error':
        this.#error = errorOf(payload);
        break;
    }
  }
}

/** Цельное сообщение: те же факты из его `usage` и `content`. */
export function messageFacts(payload: unknown): NativeFacts {
  const tokens: Tokens = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  if (!isRecord(payload)) return factsOf(tokens, { toolCalls: 0, complete: false });
  if (payload.type === 'error') {
    return factsOf(tokens, { toolCalls: 0, complete: false, upstreamError: errorOf(payload) });
  }
  readUsage(tokens, payload.usage);
  const content = Array.isArray(payload.content) ? payload.content : [];
  return factsOf(tokens, {
    toolCalls: content.filter((block) => isRecord(block) && block.type === 'tool_use').length,
    complete: payload.type === 'message' && Array.isArray(payload.content),
  });
}

/** Кадр ошибки своего диалекта: молча закрытый поток клиент покажет удачным. */
export function nativeErrorFrame(message: string, code = 'api_error'): string {
  return `event: error\ndata: ${JSON.stringify(errorBody('anthropic', message, code))}\n\n`;
}
