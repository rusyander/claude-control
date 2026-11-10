import {
  TrackerError,
  trackerErrorCodeOf,
  trackerErrorOf,
  type TrackerRequest,
  type TrackerResponse,
  type TrackerSend,
} from './index.ts';
import type { TrackerCredentials, TrackerTransport } from './client.types.ts';

/**
 * Клиент трекера на два диалекта Atlassian: облако и своя установка (Server/DC) (этап 12, D15).
 *
 * - облако: авторизация Basic `почта:токен`, Jira на `/rest/api/3`;
 * - Server/DC: авторизация `Bearer токен` (personal access token, почты нет), Jira на `/rest/api/2`.
 *
 * Токен клиент не видит: его держит замыкание порта отправки (`sendOver`) и кладёт только в
 * заголовок запроса. Сеть — тоже не здесь: транспорт дают панель (`sendRequest` с повтором и
 * потолком ожидания) и ядро (своя платформенная сеть). Отказ — `TrackerError` с кодом, а не
 * строка: какой текст показать человеку, решает тот, кто показывает.
 */

/** Адрес без хвостового слэша: иначе пути склеиваются с двойным. */
export function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Значение заголовка `Authorization`. Облако принимает Basic с почтой и API-токеном; своя
 * установка почты не знает вовсе и ждёт Bearer. Ошибиться диалектом = получить 401 на верном
 * токене, поэтому решает только `deployment`.
 */
export function authorizationOf(credentials: TrackerCredentials): string {
  if (credentials.deployment === 'cloud') {
    const pair = `${credentials.email}:${credentials.token}`;
    return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
  }
  return `Bearer ${credentials.token}`;
}

/**
 * Порт отправки поверх транспорта: заголовки авторизации и JSON добавляются здесь, токен
 * остаётся в замыкании. Исключение транспорта (не дошли вовсе) уходит наверх как есть.
 */
export function sendOver(
  transport: TrackerTransport,
  credentials: TrackerCredentials,
): TrackerSend {
  const authorization = authorizationOf(credentials);
  return (request) =>
    transport({
      url: request.url,
      method: request.method,
      system: request.system,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
}

/**
 * Ответ как JSON. Пустое тело — `null`: часть ручек Atlassian отвечает 204 без тела, и падать на
 * этом нельзя. Не JSON при удачном коде — `bad-response` с этим кодом: адрес ведёт не туда.
 */
export function parseJson<T>(system: string, response: TrackerResponse): T {
  const text = response.text.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TrackerError('bad-response', system, response.status);
  }
}

/** Отказ по коду ответа — `TrackerError`; удачный ответ проходит как есть. */
export function ensureOk(system: string, response: TrackerResponse): TrackerResponse {
  const code = trackerErrorCodeOf(response.status);
  if (code) throw trackerErrorOf(code, system, response);
  return response;
}

/** Запрос + проверка кода + разбор JSON: то, чем пользуются все чтения и записи клиента. */
export async function callJson<T>(send: TrackerSend, request: TrackerRequest): Promise<T> {
  const response = ensureOk(request.system, await send(request));
  return parseJson<T>(request.system, response);
}

/** Тело записи JSON-строкой (запрос без тела просто не зовёт эту функцию). */
export function jsonBody(value: unknown): { body: string } {
  return { body: JSON.stringify(value) };
}
