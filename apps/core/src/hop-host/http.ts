import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dialect } from '@agentdeck/contracts/core/routes';
import type { DlpApiKind } from '@agentdeck/dlp/api-shapes';
import { errorBody } from './gateway/dialect/dialect.ts';
import type { TextLanguage } from './gateway/texts.ts';

/**
 * Общее для звеньев: чтение тела с потолком, ответ JSON, отказ в форме диалекта клиента.
 * Отказ в форме самого API, а не голым текстом: CLI разбирает ошибку своей схемой, и причина
 * доходит до человека, а не превращается в «unexpected response».
 */

/** Потолок тела запроса: больше — почти наверняка вложенный файл, а не промпт (как у панели). */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Тело запроса; превышение потолка — `undefined`, остаток не дочитывается. */
export async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** Диалект контракта → вид тела у DLP-пакета и моста. */
export function apiKindOf(dialect: Dialect): DlpApiKind {
  return dialect === 'anthropic-messages' ? 'anthropic' : 'openai-compat';
}

/** Вид тела по пути запроса, когда сеанс ещё не опознан (отказ «неизвестная метка»). */
export function apiKindOfPath(path: string): DlpApiKind {
  return path.includes('/messages') ? 'anthropic' : 'openai-compat';
}

export interface Refusal {
  status: number;
  /** Код ошибки в теле — по нему клиент ветвится, не разбирая текст. */
  code: string;
  message: string;
}

export function refuse(
  response: ServerResponse,
  kind: DlpApiKind,
  refusal: Refusal,
  language: TextLanguage,
): void {
  const body = errorBody(kind, `AgentDeck: ${refusal.message}`, refusal.code, language);
  // Код звена (`dlp_opaque`) виден клиенту и в форме Anthropic: тип там — из короткого списка,
  // поэтому свой код едет рядом, а не вместо.
  if (kind === 'anthropic' && body && typeof body === 'object') {
    const error = (body as { error?: Record<string, unknown> }).error;
    if (error) error.code = refusal.code;
  }
  respondJson(response, refusal.status, body);
}

/** Запись клиенту с оглядкой на его скорость: без `drain` весь ответ копился бы в памяти. */
export function write(response: ServerResponse, text: string | Buffer): Promise<void> {
  if (!text.length || response.destroyed) return Promise.resolve();
  if (response.write(text)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

/** Клиент ушёл, не дочитав ответ: слушается ОТВЕТ, не запрос (у запроса `close` раньше, GW-06). */
export function clientGone(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) controller.abort(new Error('client gone'));
  });
  return controller.signal;
}

/**
 * Адрес наверх: путь запроса приклеивается к настроенному; префикс настройки добавляется,
 * только если его ещё нет (`…/v1` + `/v1/messages` не даёт `/v1/v1/messages`).
 */
export function joinUpstream(upstream: string, path: string): string {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const full = !prefix || suffix.startsWith(`${prefix}/`) ? suffix : `${prefix}${suffix}`;
  return `${base.origin}${full}`;
}
