import type { CoreSseEvent } from './core-relay.types.ts';

/**
 * Разбор потока SSE ядра (`apps/core/src/api/sse.ts`): события разделены пустой строкой,
 * строки `:` — комментарии (`: open`, `: ping`), `data:` в событии может быть несколько.
 * Чужого клиента SSE в сервере нет — поток читается fetch-ем через прокладку, и разбор свой.
 */
export async function* parseSse(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<CoreSseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];
  const flush = (): CoreSseEvent | null => {
    const out = data.length > 0 ? { id, event, data: data.join('\n') } : null;
    id = null;
    event = null;
    data = [];
    return out;
  };
  const lineOf = (line: string): CoreSseEvent | null => {
    if (line === '') return flush();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.search(/\r?\n/);
    while (cut !== -1) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(buffer[cut] === '\r' ? cut + 2 : cut + 1);
      const done = lineOf(line);
      if (done) yield done;
      cut = buffer.search(/\r?\n/);
    }
  }
  // Оборванное событие без пустой строки — недописанное: ядро его не закончило, не отдаём.
}
