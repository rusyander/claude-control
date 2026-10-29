/**
 * Кадр потока SSE (WHATWG «server-sent events»): необязательная строка `event:`,
 * строка `data:` и пустая строка — конец события. Данные — одна строка JSON
 * (`JSON.stringify` переводов строк не оставляет), поэтому одной `data:` хватает.
 * `[DONE]` OpenAI chat — строка как есть, не JSON.
 */
export function frame(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}

/** Заголовки ответа-потока: так отвечают API Anthropic и OpenAI. */
export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
});
