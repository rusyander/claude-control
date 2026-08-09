import { currentConnection } from './connection';
import { dict } from '../config/i18n';

/**
 * Запросы к панели. Тонкий слой поверх fetch, а не axios: единственное, что
 * нужно добавить к каждому запросу, — адрес и токен, и ради этого тащить
 * клиентскую библиотеку незачем.
 *
 * Ошибка приходит наверх с текстом сервера: панель отвечает `{message}` почти
 * везде, и подменять его своим «не удалось» — прятать единственное объяснение.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Адрес запроса вместе с базой соединения. `path` начинается со слэша. */
export function apiUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const { url } = currentConnection();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const tail = search.toString();
  return `${url}/api${path}${tail ? `?${tail}` : ''}`;
}

export function authHeaders(): Record<string, string> {
  const { token } = currentConnection();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const TIMEOUT_MS = 20_000;

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<T> {
  const { url } = currentConnection();
  if (!url) throw new ApiError(0, dict().api.notConfigured);

  let response: Response;
  try {
    response = await fetch(apiUrl(path, options.query), {
      method,
      headers: {
        ...authHeaders(),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // До сервера не дошли вовсе: выключен компьютер, оборвалась сеть, нет
    // Tailscale. Это не 500 — и текст должен говорить именно об этом.
    const t = dict().api;
    throw new ApiError(
      0,
      error instanceof Error && error.name === 'TimeoutError' ? t.silent : t.unreachable,
    );
  }

  if (!response.ok) {
    let message = dict().run.answered(response.status);
    let code: string | undefined;
    try {
      const body = (await response.json()) as { message?: string; error?: string; code?: string };
      message = body.message || body.error || message;
      code = body.code;
    } catch {
      // Тело не JSON — остаётся статус.
    }
    if (response.status === 401) message = dict().api.tokenRejected;
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>) =>
    request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
  /**
   * DELETE, адресующий удаляемое строкой запроса, а не телом. Панель принимает
   * оба вида — какой именно, решает маршрут, и подменять один другим нельзя:
   * тело у DELETE читают не все прокси.
   */
  deleteBy: <T>(path: string, query?: Record<string, string | number | undefined>) =>
    request<T>('DELETE', path, { query }),
};
