import { unreachable } from './errors.ts';
import { coded, type CodedText } from '../../lib/server-text.ts';

/**
 * Единственный способ, которым панель выходит наружу.
 *
 * Правила одни на все пять интеграций и живут ЗДЕСЬ, а не в каждом клиенте:
 * потолок ожидания 15 с, ОДНА повторная попытка и только на 429/502/503 (с
 * уважением к `Retry-After`), а любой отказ превращается в русскую строку,
 * которую можно показать человеку не переводя.
 *
 * Почему один повтор, а не три: панель ходит наружу по нажатию кнопки и в
 * середине прогона. Настойчивый повтор превращает недоступный сервис в минуту
 * тишины на экране, а 429 от Atlassian при этом ещё и продлевает себя сам.
 *
 * Токен сюда приходит уже собранным в заголовок и НИКУДА отсюда не попадает:
 * в тексты ошибок уходит только адрес, код ответа и хвост тела ответа.
 */

/** Потолок ожидания одного запроса. Больше — интерфейс выглядит зависшим. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Сколько ждём по `Retry-After`, даже если сервис попросил больше. */
const MAX_RETRY_DELAY_MS = 5_000;

/** Коды, на которых повтор имеет смысл: перегрузка и временная недоступность. */
const RETRYABLE = new Set([429, 502, 503]);

export interface OutboundRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Тело: строка (JSON собран вызывающим) или ничего. */
  body?: string;
  /** Как называть систему в тексте ошибки: «Jira», «Telegram», «GitHub». */
  system: string;
  /** Ожидаемый ответ — байты, а не JSON (артефакт CI). */
  binary?: boolean;
  /**
   * Чем назвать адрес в подробности отказа. Нужен там, где СЕКРЕТ ЛЕЖИТ В
   * АДРЕСЕ: у Telegram токен бота — часть пути (`/bot<токен>/sendMessage`), и
   * подробность «не дозвонились по такому-то адресу» вынесла бы его в ответ API
   * и в журнал. Не задан — показывается сам адрес.
   */
  label?: string;
}

export interface OutboundResponse {
  status: number;
  ok: boolean;
  text: string;
  bytes?: Buffer;
  headers: Headers;
}

/** Пауза между попытками: `Retry-After` в секундах или в виде даты. */
function retryDelay(header: string | null): number {
  if (!header) return 1_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1_000, MAX_RETRY_DELAY_MS);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return 1_000;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Один поход наружу. Возвращает ответ ЛЮБОГО кода — решение, что 404 значит для
 * этой ручки, принимает вызывающий. Исключение здесь только одно: до сервиса не
 * дошли вовсе (нет сети, не разобрался адрес, вышло время).
 */
export async function sendRequest(request: OutboundRequest): Promise<OutboundResponse> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkFailure(request.system, error, request.label ?? request.url);
    }

    if (attempt === 1 && RETRYABLE.has(response.status)) {
      await wait(retryDelay(response.headers.get('retry-after')));
      continue;
    }

    if (request.binary) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        ok: response.ok,
        // Текст нужен только для сообщения об отказе: тело-ошибка всегда мелкое.
        text: response.ok ? '' : bytes.subarray(0, 2_000).toString('utf8'),
        bytes,
        headers: response.headers,
      };
    }

    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
      headers: response.headers,
    };
  }
}

/** Не дошли вовсе: нет сети, не разобрался адрес, вышло время. */
function networkFailure(system: string, error: unknown, detail: string) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    const seconds = REQUEST_TIMEOUT_MS / 1_000;
    return coded(
      unreachable(`${system} не ответила за ${seconds} с.`, detail),
      'integration-timeout',
      { system, seconds },
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return coded(unreachable(`Нет связи с ${system}: ${reason}.`, detail), 'integration-network', {
    system,
    reason,
  });
}

/**
 * Отказ по коду ответа — одной русской фразой.
 *
 * 401 и 403 названы отдельно и одинаково: с точки зрения человека это один
 * случай — «панель постучалась, её не пустили», и чинится он в одном месте.
 */
export function describeFailure(system: string, response: OutboundResponse): string {
  const tail = response.text.trim().slice(0, 200);
  if (response.status === 401 || response.status === 403) {
    return `${system}: токен отклонён (${response.status}). Проверьте учётные данные в настройках.`;
  }
  if (response.status === 404) {
    return `${system}: адрес не найден (404) — проверьте адрес сайта и идентификаторы.`;
  }
  if (response.status === 429) {
    return `${system}: слишком много запросов (429), попробуйте позже.`;
  }
  if (response.status >= 500) {
    return `${system}: сервер ответил ошибкой ${response.status}.`;
  }
  return `${system}: запрос отклонён (${response.status})${tail ? `: ${tail}` : ''}.`;
}

/** Та же фраза кодом — ветви один в один с `describeFailure`. */
export function failureCode(system: string, response: OutboundResponse): CodedText {
  const status = response.status;
  if (status === 401 || status === 403)
    return { messageCode: 'integration-token-rejected', params: { system, status } };
  if (status === 404) return { messageCode: 'integration-address-404', params: { system } };
  if (status === 429) return { messageCode: 'integration-rate-limited', params: { system } };
  if (status >= 500) return { messageCode: 'integration-server-error', params: { system, status } };
  const tail = response.text.trim().slice(0, 200);
  return {
    messageCode: 'integration-request-rejected',
    params: { system, status, tail: tail ? `: ${tail}` : '' },
  };
}

/** Отказ по коду ответа как ошибка интеграции: русская фраза, код и хвост тела. */
export function failedResponse(system: string, response: OutboundResponse, detailLength = 500) {
  return Object.assign(
    unreachable(describeFailure(system, response), response.text.trim().slice(0, detailLength)),
    failureCode(system, response),
  );
}

/** Ответ обязан быть удачным; иначе — 502 с русской причиной и хвостом тела. */
export function ensureOk(system: string, response: OutboundResponse): OutboundResponse {
  if (response.ok) return response;
  throw failedResponse(system, response);
}

/**
 * Ответ разбирается как JSON. Пустое тело — это `null`: часть ручек Atlassian
 * отвечает 204 без тела, и падать на этом нельзя.
 */
export function parseJson<T>(system: string, response: OutboundResponse): T {
  const text = response.text.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw coded(
      unreachable(`${system} ответила не JSON — похоже, адрес ведёт не туда.`, text.slice(0, 200)),
      'integration-not-json',
      { system },
    );
  }
}

/** Удачный запрос + разбор JSON: то, чем пользуются все клиенты. */
export async function requestJson<T>(request: OutboundRequest): Promise<T> {
  const response = ensureOk(request.system, await sendRequest(request));
  return parseJson<T>(request.system, response);
}
