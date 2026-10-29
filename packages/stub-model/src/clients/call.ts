/** Один запрос клиента-оракула к заглушке по настоящему HTTP: ответ разобран, время замерено. */
import type { DialectId } from '../index.d.mts';
import type { Outcome } from '../conformance.cases.ts';
import { CLIENTS, type RequestOptions } from './index.ts';
import type { Reply } from './reply.ts';

/** `signal` оборвал запрос — исход без ответа: так клиент, ушедший посреди удержания. */
const ABORTED: Reply = {
  kind: 'error',
  midStream: false,
  type: 'aborted',
  message: 'client aborted',
};

export async function call(
  baseUrl: string,
  dialect: DialectId,
  options: RequestOptions,
  signal?: AbortSignal,
): Promise<Outcome> {
  const client = CLIENTS[dialect];
  const started = performance.now();
  let text = '';
  let firstByteMs = -1;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${client.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...client.headers },
      body: JSON.stringify(client.request(options)),
      signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    for (; reader;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs < 0) firstByteMs = performance.now() - started;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (!signal?.aborted) throw error;
    const totalMs = performance.now() - started;
    return { status: 0, headers: new Headers(), reply: ABORTED, firstByteMs, totalMs, text };
  }
  const totalMs = performance.now() - started;
  const type = response.headers.get('content-type') ?? '';
  // Тип носителя — без учёта регистра (RFC 9110 §8.3.1).
  const reply = /^text\/event-stream/i.test(type)
    ? client.stream(text)
    : client.json(jsonBody(dialect, response.status, type, text));
  return { status: response.status, headers: response.headers, reply, firstByteMs, totalMs, text };
}

/** Тело не потока — объект JSON; иначе провал с протоколом, статусом и началом тела. */
function jsonBody(
  dialect: DialectId,
  status: number,
  type: string,
  text: string,
): Record<string, unknown> {
  const where = `${dialect}: HTTP ${status} ${type || '(no content-type)'}`;
  if (!text) throw new Error(`${where}: empty body`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${where}: body is not JSON: ${text.slice(0, 200)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${where}: body is not a JSON object: ${text.slice(0, 200)}`);
  return value as Record<string, unknown>;
}
