import { isTrackerError, type TrackerSend } from '@agentdeck/trackers';
import { sendOver } from '@agentdeck/trackers/client';
import type { TrackerCredentials, TrackerSite } from '@agentdeck/trackers/client.types';
import { coded } from '../../../lib/server-text/server-text.ts';
import { unreachable } from '../errors.ts';
import { failedResponse, parseJson, sendRequest, type OutboundResponse } from '../http/http.ts';

/** Доступ, каким его собирает `client.ts` (`AtlassianAccess`): сайт и учётные данные. */
type AtlassianAccess = TrackerCredentials & { baseUrl: string };

/**
 * Порт панели к клиенту трекера (этап 12, D15): пакет `@agentdeck/trackers` шлёт запросы через
 * `sendRequest` панели (потолок ожидания, один повтор) и отказывает кодом, а русский текст отказа
 * выбирает панель — здесь, по последнему ответу этой операции. Порт заводится на ОДНУ операцию:
 * «последний ответ» чужой операции в отказ не попадёт.
 */

export interface TrackerPort {
  site: TrackerSite;
  send: TrackerSend;
  /** Последний ответ этой операции (с заголовками — его ждёт `failedResponse`). */
  last: () => OutboundResponse | undefined;
}

export function trackerPort(access: AtlassianAccess): TrackerPort {
  let last: OutboundResponse | undefined;
  const send = sendOver(
    async (request) => {
      last = await sendRequest(request);
      return last;
    },
    { deployment: access.deployment, email: access.email, token: access.token },
  );
  return {
    site: { baseUrl: access.baseUrl, deployment: access.deployment },
    send,
    last: () => last,
  };
}

/**
 * Отказ пакета → отказ панели. Неудачный код — та же фраза, что у прочих интеграций
 * (`failedResponse`: 401/403 — токен отклонён, 404 — адрес не найден…); удачный код с телом не
 * того вида — «ответила не JSON». Прочие исключения (сеть, программа) проходят как есть.
 */
export function serverErrorOf(error: unknown, last: OutboundResponse | undefined): unknown {
  if (!isTrackerError(error) || last === undefined) return error;
  if (!last.ok) return failedResponse(error.system, last, 500);
  try {
    parseJson(error.system, last);
  } catch (notJson) {
    return notJson;
  }
  return coded(
    unreachable(`${error.system} ответила не JSON — похоже, адрес ведёт не туда.`),
    'integration-not-json',
    { system: error.system },
  );
}

/** Операция клиента трекера с отказом в словах панели. */
export async function viaTracker<T>(
  access: AtlassianAccess,
  run: (site: TrackerSite, send: TrackerSend) => Promise<T>,
): Promise<T> {
  const port = trackerPort(access);
  try {
    return await run(port.site, port.send);
  } catch (error) {
    throw serverErrorOf(error, port.last());
  }
}
