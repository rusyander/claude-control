/**
 * Трекеры задач (этап 12, D15, P165): общее ядру и панели. Клиент трекера не знает ни токена, ни
 * диска — он получает порт отправки (`TrackerSend`), а токен живёт только в замыкании этого порта и
 * в заголовке запроса. Отказ — типизированный код, а не строка: входящие ядра превращают его в
 * «неизвестно» с причиной, панель — в свой текст. Пакет ничего не импортирует из `apps/`.
 */

/** Один запрос к трекеру: адрес уже полный, тело — JSON-строка, учётные данные добавляет порт. */
export interface TrackerRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  /** JSON, собранный вызывающим; нет — запрос без тела. */
  body?: string;
  /** Как называть систему в отказе: «Jira». */
  system: string;
}

/** Ответ ЛЮБОГО кода: что значит 404 для этой ручки, решает вызывающий. */
export interface TrackerResponse {
  status: number;
  ok: boolean;
  text: string;
  /** Заголовок `Retry-After` (429/503) в мс, если транспорт его разобрал; нет — трекер не сказал. */
  retryAfterMs?: number;
}

/** Порт отправки: бросает только когда до трекера не дошли вовсе (сеть, адрес, время). */
export type TrackerSend = (request: TrackerRequest) => Promise<TrackerResponse>;

/** Коды отказа трекера — исчерпывающий список, по нему вызывающий выбирает текст. */
export const TRACKER_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not-found',
  'rate-limited',
  'unreachable',
  'bad-response',
  'server-error',
] as const;
export type TrackerErrorCode = (typeof TRACKER_ERROR_CODES)[number];

/** Отказ трекера: код, система и код ответа (если ответ был). Текста ответа и токена в нём нет. */
export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly system: string;
  readonly status: number | undefined;
  /** Когда трекер велел прийти снова (`Retry-After`), мс; нет — не сказал. */
  readonly retryAfterMs: number | undefined;

  constructor(code: TrackerErrorCode, system: string, status?: number, retryAfterMs?: number) {
    super(`${system}: ${code}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'TrackerError';
    this.code = code;
    this.system = system;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Отказ по ответу: код, статус и `Retry-After` ответа в одном месте. */
export function trackerErrorOf(
  code: TrackerErrorCode,
  system: string,
  response: TrackerResponse,
): TrackerError {
  return new TrackerError(code, system, response.status, response.retryAfterMs);
}

/** Код отказа по коду ответа; успешный ответ — `null`. */
export function trackerErrorCodeOf(status: number): TrackerErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'bad-response';
}

export function isTrackerError(error: unknown): error is TrackerError {
  return error instanceof TrackerError;
}
