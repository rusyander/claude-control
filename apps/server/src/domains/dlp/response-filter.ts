import { createStreamReplacer, replaceAll, type StreamReplacer } from './stream-replace.ts';
import { parseFrame, serializeFrame, splitFrames } from './sse.ts';
import { deltaTextOf, mapBodyTexts, withDeltaText, type DlpApiKind } from './api-shapes.ts';

/**
 * Обратная подстановка в ответе модели: метки снова становятся значениями,
 * прежде чем ответ дойдёт до CLI.
 *
 * Тонкость, ради которой этот модуль отдельный: метка приезжает НЕ ЦЕЛИКОМ.
 * Ответ идёт кадрами SSE, кадр — куском TCP, а текст внутри кадра — своей
 * порцией; `[ИМЯ_1]` спокойно разрывается на три события. Поэтому текст всех
 * кадров одного блока склеивается в один поток (`stream-replace.ts`), а
 * удержанный им хвост выпускается синтетическим кадром той же формы — перед
 * первым же кадром другого рода. Ни один символ не теряется и не уходит раньше
 * времени.
 *
 * Каналы (`text:0`, `json:1`, `content:0`) разделены намеренно: метка не может
 * начаться в тексте ответа и закончиться в аргументах инструмента, а вот
 * подстановка «через границу» испортила бы оба.
 */
/**
 * Та же карта, но значения экранированы для JSON-СТРОКИ.
 *
 * Аргументы вызова инструмента едут упакованным JSON, и подстановка в них —
 * подстановка в текст, а не в значение. Путь `C:\Users\rusyander`, вставленный
 * туда как есть, даёт `\U` — недопустимое экранирование, после которого клиент
 * не разбирает вызов ЦЕЛИКОМ и агент молча ничего не делает. Ключи не трогаем:
 * в метке только буквы, цифры и подчёркивание.
 */
function jsonEscaped(reverse: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [alias, value] of reverse) out.set(alias, JSON.stringify(value).slice(1, -1));
  return out;
}

export class ResponseStreamFilter {
  readonly #kind: DlpApiKind;
  readonly #reverse: ReadonlyMap<string, string>;
  readonly #reverseJson: ReadonlyMap<string, string>;

  #buffer = '';
  #channel?: string;
  #replacer?: StreamReplacer;
  #envelope?: unknown;
  #event?: string;

  constructor(kind: DlpApiKind, reverse: ReadonlyMap<string, string>) {
    this.#kind = kind;
    this.#reverse = reverse;
    this.#reverseJson = jsonEscaped(reverse);
  }

  /** Очередной кусок ответа; возвращает то, что можно отдать CLI. */
  push(chunk: string): string {
    if (this.#reverse.size === 0) return chunk;

    this.#buffer += chunk;
    const { frames, rest } = splitFrames(this.#buffer);
    this.#buffer = rest;

    let out = '';
    for (const raw of frames) out += this.#frame(raw);
    return out;
  }

  /** Конец ответа: выпустить удержанный хвост и незавершённый кадр как есть. */
  end(): string {
    if (this.#reverse.size === 0) return this.#takeBuffer();
    return this.#flushChannel() + this.#takeBuffer();
  }

  #takeBuffer(): string {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest;
  }

  #frame(raw: string): string {
    const frame = parseFrame(raw);
    if (frame.data.length === 0) return this.#flushChannel() + raw + '\n\n';

    // Спецификация SSE склеивает несколько строк `data:` переводом строки.
    const payload = frame.data.join('\n');
    const event = parseJson(payload);
    const delta = event === undefined ? undefined : deltaTextOf(event, this.#kind);

    // `[DONE]`, `ping`, начало и конец блока — всё, что не текст, идёт как есть.
    if (!delta) return this.#flushChannel() + raw + '\n\n';

    let prefix = '';
    if (delta.channel !== this.#channel) {
      prefix = this.#flushChannel();
      this.#channel = delta.channel;
      this.#replacer = createStreamReplacer(
        delta.slot === 'json' ? this.#reverseJson : this.#reverse,
      );
    }

    this.#envelope = event;
    this.#event = frame.event;

    const safe = this.#replacer?.push(delta.text) ?? delta.text;
    if (!safe) return prefix;
    return prefix + this.#emit(safe);
  }

  #flushChannel(): string {
    const rest = this.#replacer?.flush() ?? '';
    const out = rest ? this.#emit(rest) : '';
    this.#channel = undefined;
    this.#replacer = undefined;
    this.#envelope = undefined;
    this.#event = undefined;
    return out;
  }

  #emit(text: string): string {
    if (this.#envelope === undefined) return '';
    const event = withDeltaText(this.#envelope, this.#kind, text);
    return serializeFrame(this.#event, JSON.stringify(event));
  }
}

/** Цельный (не потоковый) ответ: та же подстановка по документированным полям. */
export function restoreJsonResponse(
  body: unknown,
  kind: DlpApiKind,
  reverse: ReadonlyMap<string, string>,
): unknown {
  if (reverse.size === 0) return body;
  const escaped = jsonEscaped(reverse);
  return mapBodyTexts(body, kind, (text, slot) =>
    replaceAll(text, slot === 'json' ? escaped : reverse),
  );
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
