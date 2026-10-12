import type { ApiMethod, ApiSendResult } from '@agentdeck/contracts';
import { ApiSendError } from './api-explorer.types.ts';

/**
 * Запрос уходит с сервера панели, а не из браузера: у API разработчика нет CORS
 * для порта панели, и браузер такой ответ не отдал бы. Тело ответа читается до
 * предела — гигабайтный выгрузчик не положит панель.
 */

export const SEND_TIMEOUT_MS = 30_000;
export const BODY_CAP_BYTES = 2 * 1024 * 1024;

/** Эти заголовки ставит сам fetch; заданные руками он отвергает или они лгут о теле. */
const DROPPED = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

const BINARY =
  /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z|vnd\.)/i;

export interface SendInput {
  method: ApiMethod;
  url: string;
  headers: [string, string][];
  body?: string;
  timeoutMs?: number;
  capBytes?: number;
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

async function readCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; size: number; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), size: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = cap - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      size += room;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size, truncated };
}

export async function sendRequest(input: SendInput): Promise<ApiSendResult> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    throw new ApiSendError('bad-url', `Не адрес: ${input.url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new ApiSendError('bad-url', `Только http и https, а не ${target.protocol}`);

  const headers = new Headers();
  for (const [name, value] of input.headers) {
    const key = name.trim();
    if (!key || DROPPED.has(key.toLowerCase())) continue;
    try {
      headers.append(key, value);
    } catch {
      throw new ApiSendError('bad-url', `Заголовок не принят: ${key}`, key);
    }
  }
  const withBody =
    input.body !== undefined && input.body !== '' && !['get', 'head'].includes(input.method);
  const timeoutMs = input.timeoutMs ?? SEND_TIMEOUT_MS;
  const seconds = Math.round(timeoutMs / 1000);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(target, {
      method: input.method.toUpperCase(),
      headers,
      ...(withBody ? { body: input.body } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError')
      throw new ApiSendError('timeout', `Нет ответа за ${seconds} с`, String(seconds));
    // fetch по стандарту не ходит на «опасные» порты (1, 6000, 6665–6669, 10080…):
    // это не отказ сервиса, а запрет самого fetch — говорим прямо.
    if ((error as { cause?: { message?: string } }).cause?.message === 'bad port')
      throw new ApiSendError('bad-url', `Порт ${target.port} запрещён для fetch`, 'bad-port');
    const code = causeCode(error);
    throw new ApiSendError(
      'connect',
      code ? `${code} ${target.host}` : (error as Error).message,
      code,
    );
  }
  const contentType = response.headers.get('content-type') ?? undefined;
  const binary = Boolean(contentType && BINARY.test(contentType));
  let read: Awaited<ReturnType<typeof readCapped>>;
  try {
    read = await readCapped(response, input.capBytes ?? BODY_CAP_BYTES);
  } catch (error) {
    if ((error as Error).name === 'TimeoutError')
      throw new ApiSendError('timeout', `Тело не дочитано за ${seconds} с`, String(seconds));
    throw new ApiSendError('connect', (error as Error).message);
  }
  const durationMs = Math.round(performance.now() - started);
  const declared = Number(response.headers.get('content-length'));
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: binary ? '' : new TextDecoder().decode(read.bytes),
    bodyTruncated: read.truncated,
    ...(binary ? { binary: true } : {}),
    sizeBytes:
      read.truncated && Number.isFinite(declared) && declared > read.size ? declared : read.size,
    durationMs,
    ...(contentType ? { contentType } : {}),
    url: response.url || target.toString(),
  };
}
