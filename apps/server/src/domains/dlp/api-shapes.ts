/**
 * Где в теле запроса и ответа лежит текст — по документации каждого API.
 *
 * Общего «пройти по всем строкам JSON» здесь нет намеренно: под замену попали
 * бы имя модели, идентификаторы блоков, base64 картинки и подписи. Правится
 * только то, что задокументировано как пользовательский текст, — остальное
 * проходит нетронутым.
 *
 * Формы сверены с первоисточниками: Anthropic Messages (`system`, `messages[]`,
 * блоки `text` / `tool_result` / `tool_use`, поток `content_block_delta` с
 * `text_delta.text` и `input_json_delta.partial_json`) и OpenAI Chat
 * Completions (`messages[].content`, `tool_calls[].function.arguments`, поток
 * `choices[].delta.content`). Схема Gemini в прокси пока не разбирается — и
 * значит, не пропускается: незнакомая форма отклоняется, а не идёт мимо правил.
 */

export type DlpApiKind = 'anthropic' | 'openai-compat';

type Json = unknown;
type TextFn = (text: string) => string;

/**
 * Какому API принадлежит путь. База адреса у CLI может включать `/v1`, а может
 * и не включать — поэтому сравнивается хвост пути, а не путь целиком.
 */
export function apiKindForPath(path: string): DlpApiKind | undefined {
  const clean = (path.split('?')[0] ?? path).replace(/\/+$/, '');
  if (clean.endsWith('/v1/messages') || clean.endsWith('/messages')) return 'anthropic';
  if (clean.endsWith('/messages/count_tokens')) return 'anthropic';
  if (clean.endsWith('/chat/completions')) return 'openai-compat';
  return undefined;
}

/** Пройти по строковым листьям произвольного объекта (аргументы инструмента). */
function mapStrings(value: Json, fn: TextFn): Json {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, Json>)) {
      out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

function isRecord(value: Json): value is Record<string, Json> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Содержимое реплики: строка либо массив блоков — обе формы документированы. */
function mapContent(content: Json, fn: TextFn, blockFn: (block: Json, fn: TextFn) => Json): Json {
  if (typeof content === 'string') return fn(content);
  if (Array.isArray(content)) return content.map((block) => blockFn(block, fn));
  return content;
}

function mapAnthropicBlock(block: Json, fn: TextFn): Json {
  if (!isRecord(block)) return block;

  // Блок размышлений не трогаем НИКОГДА: к нему приложена подпись, и любая
  // правка текста делает её недействительной — запрос отвергнет уже сам API.
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return block;

  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: fn(block.text) };
  }
  if (block.type === 'tool_result') {
    return { ...block, content: mapContent(block.content, fn, mapAnthropicBlock) };
  }
  if (block.type === 'tool_use' && block.input !== undefined) {
    return { ...block, input: mapStrings(block.input, fn) };
  }
  return block;
}

function mapAnthropicBody(body: Json, fn: TextFn): Json {
  if (!isRecord(body)) return body;
  const out: Record<string, Json> = { ...body };

  if (out.system !== undefined) out.system = mapContent(out.system, fn, mapAnthropicBlock);

  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) =>
      isRecord(message)
        ? { ...message, content: mapContent(message.content, fn, mapAnthropicBlock) }
        : message,
    );
  }

  // Ответ (не поток) держит блоки на верхнем уровне.
  if (Array.isArray(out.content)) {
    out.content = out.content.map((block) => mapAnthropicBlock(block, fn));
  }

  return out;
}

function mapOpenAiMessage(message: Json, fn: TextFn): Json {
  if (!isRecord(message)) return message;
  const out: Record<string, Json> = { ...message };

  if (out.content !== undefined) {
    out.content = mapContent(out.content, fn, (block, inner) =>
      isRecord(block) && typeof block.text === 'string'
        ? { ...block, text: inner(block.text) }
        : block,
    );
  }

  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((call) => {
      if (!isRecord(call) || !isRecord(call.function)) return call;
      const fnBlock = call.function;
      // `arguments` — JSON, УПАКОВАННЫЙ в строку: заменяем как текст. Метка
      // состоит из букв, цифр и скобок, экранирования JSON не ломает.
      return typeof fnBlock.arguments === 'string'
        ? { ...call, function: { ...fnBlock, arguments: fn(fnBlock.arguments) } }
        : call;
    });
  }

  return out;
}

function mapOpenAiBody(body: Json, fn: TextFn): Json {
  if (!isRecord(body)) return body;
  const out: Record<string, Json> = { ...body };

  if (Array.isArray(out.messages))
    out.messages = out.messages.map((item) => mapOpenAiMessage(item, fn));

  // Ответ (не поток): choices[].message.
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((choice) =>
      isRecord(choice) && isRecord(choice.message)
        ? { ...choice, message: mapOpenAiMessage(choice.message, fn) }
        : choice,
    );
  }

  return out;
}

/** Пройти по пользовательскому тексту тела — и запроса, и цельного ответа. */
export function mapBodyTexts(body: Json, kind: DlpApiKind, fn: TextFn): Json {
  return kind === 'anthropic' ? mapAnthropicBody(body, fn) : mapOpenAiBody(body, fn);
}

/**
 * Кусок текста в кадре потока: какой «канал» он продолжает и что в нём лежит.
 * Канал нужен обратной подстановке — метка не может начаться в тексте одного
 * блока и закончиться в аргументах другого, поэтому у каждого канала свой
 * накопитель.
 */
export interface DeltaText {
  channel: string;
  text: string;
}

export function deltaTextOf(event: Json, kind: DlpApiKind): DeltaText | undefined {
  if (!isRecord(event)) return undefined;

  if (kind === 'anthropic') {
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return undefined;
    const index = typeof event.index === 'number' ? event.index : 0;
    const delta = event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { channel: `text:${index}`, text: delta.text };
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      return { channel: `json:${index}`, text: delta.partial_json };
    }
    // thinking_delta и signature_delta — мимо: подпись должна дойти как есть.
    return undefined;
  }

  if (!Array.isArray(event.choices)) return undefined;
  const choice = event.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) return undefined;
  const index = typeof choice.index === 'number' ? choice.index : 0;
  if (typeof choice.delta.content === 'string') {
    return { channel: `content:${index}`, text: choice.delta.content };
  }
  return undefined;
}

/** Тот же кадр с подменённым текстом — для выпуска наружу. */
export function withDeltaText(event: Json, kind: DlpApiKind, text: string): Json {
  if (!isRecord(event)) return event;

  if (kind === 'anthropic') {
    if (!isRecord(event.delta)) return event;
    const delta = event.delta;
    if (delta.type === 'text_delta') return { ...event, delta: { ...delta, text } };
    if (delta.type === 'input_json_delta')
      return { ...event, delta: { ...delta, partial_json: text } };
    return event;
  }

  if (!Array.isArray(event.choices)) return event;
  const choices = event.choices.map((choice, position) =>
    position === 0 && isRecord(choice) && isRecord(choice.delta)
      ? { ...choice, delta: { ...choice.delta, content: text } }
      : choice,
  );
  return { ...event, choices };
}
