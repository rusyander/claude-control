import { parseFrame, serializeFrame, splitFrames } from '../../dlp/sse.ts';
import { ThinkSplitter, type ThinkMode } from './think-tail.ts';

/**
 * Размышления текстом на РОДНОЙ ручке Anthropic (решение по контуру №8).
 *
 * На мосту текст модели собирает переводчик потока, и `ThinkSplitter` стоит у
 * него внутри. Родная ручка (DRV-07) отдаёт клиенту кадры платформы как есть —
 * и модель вроде Qwen3.8 за vLLM `/v1/messages` доносила до человека свой
 * черновик с голым `</think>`, а прослойка агента читала вызовы из прикидок.
 * Поэтому здесь тот же разделитель, но над кадрами диалекта Anthropic:
 * `text_delta` первого текстового блока проходит через него, всё прочее —
 * размышления платформы блоком `thinking`, подписи, вызовы, расход — байт в байт.
 *
 * Только ПЕРВЫЙ текстовый блок: размышление стоит в начале ответа, а текст после
 * вызова инструмента — уже ответ, и держать его значило бы ломать поток.
 */
/** Кадры, после которых текст первого блока уже не продолжится. */
const CLOSING = new Set([
  'content_block_stop',
  'content_block_start',
  'message_delta',
  'message_stop',
  'error',
]);

export class NativeThinkFilter {
  readonly #splitter: ThinkSplitter;
  #buffer = '';
  /** Индекс первого текстового блока; `undefined` — его ещё не было. */
  #index?: number;
  /** Первый текстовый блок закрыт — дальше разделять нечего. */
  #done = false;
  /** Последний кадр текста — форма для придержанного хвоста. */
  #envelope?: Record<string, unknown>;
  #event?: string;

  constructor(mode: ThinkMode) {
    this.#splitter = new ThinkSplitter(mode);
  }

  get reasoningChars(): number {
    return this.#splitter.reasoningChars;
  }

  get sawBareClose(): boolean {
    return this.#splitter.sawBareClose;
  }

  /** Кусок потока платформы → то, что можно отдать клиенту сейчас. */
  push(chunk: string): string {
    if (this.#done && !this.#buffer) return chunk;
    this.#buffer += chunk;
    const { frames, rest } = splitFrames(this.#buffer);
    this.#buffer = rest;
    let out = '';
    for (const raw of frames) out += this.#frame(raw);
    return out;
  }

  /** Конец потока: придержанное отдаётся текстом, а не теряется. */
  end(): string {
    const rest = this.#buffer;
    this.#buffer = '';
    return this.#release() + rest;
  }

  #frame(raw: string): string {
    const whole = `${raw}\n\n`;
    if (this.#done) return whole;
    const frame = parseFrame(raw);
    const payload = parseJson(frame.data.join('\n'));
    if (!payload) return whole;

    const index = typeof payload.index === 'number' ? payload.index : 0;
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    const isText =
      payload.type === 'content_block_delta' &&
      delta?.type === 'text_delta' &&
      typeof delta.text === 'string';

    if (isText && (this.#index === undefined || this.#index === index)) {
      this.#index = index;
      this.#envelope = payload;
      this.#event = frame.event;
      const text = this.#splitter.push(delta.text as string);
      return text ? this.#emit(text) : '';
    }

    // Блок закрылся (или начался следующий, или ответ кончился): придержанное
    // уходит ПЕРЕД этим кадром, иначе клиент получил бы текст после
    // `content_block_stop`. `ping` посреди размышления хвост не выпускает —
    // иначе черновик модели ушёл бы клиенту на первом же пинге.
    if (this.#index !== undefined && CLOSING.has(String(payload.type))) {
      this.#done = true;
      return this.#release() + whole;
    }
    return whole;
  }

  #release(): string {
    const held = this.#splitter.end();
    return held ? this.#emit(held) : '';
  }

  #emit(text: string): string {
    if (!this.#envelope) return '';
    const delta = isRecord(this.#envelope.delta) ? this.#envelope.delta : {};
    return serializeFrame(
      this.#event,
      JSON.stringify({ ...this.#envelope, delta: { ...delta, text } }),
    );
  }
}

/**
 * Цельное сообщение: тот же разделитель над первым текстовым блоком. Возвращает
 * НОВОЕ тело — пришедшее не меняется.
 */
export function withoutThinkMessage(
  payload: unknown,
  mode: ThinkMode,
): { payload: unknown; reasoningChars: number; sawBareClose: boolean } {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    return { payload, reasoningChars: 0, sawBareClose: false };
  }
  const at = payload.content.findIndex(
    (block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string',
  );
  if (at < 0) return { payload, reasoningChars: 0, sawBareClose: false };
  const block = payload.content[at] as Record<string, unknown>;
  const splitter = new ThinkSplitter(mode);
  const text = splitter.push(block.text as string) + splitter.end();
  const content = [...payload.content];
  content[at] = { ...block, text };
  return {
    payload: { ...payload, content },
    reasoningChars: splitter.reasoningChars,
    sawBareClose: splitter.sawBareClose,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
