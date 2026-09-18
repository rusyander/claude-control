import { createHmac } from 'node:crypto';
import type { NotifyEvent, WebhookPayload, WebhookSettings } from '@agentdeck/contracts';
import { failedResponse, sendRequest } from '../integrations/http.ts';
import { invalidField } from '../integrations/errors.ts';
import { compose, noticeEvent, type TelegramNotice } from './telegram.ts';
import { LEGACY_BRAND_NAME } from '../../lib/brand.mjs';

/**
 * Вебхук — те же события панели, но своим адресом.
 *
 * Telegram закрывает ровно одного адресата и требует бота; спрашивают же про
 * Slack, Mattermost, дежурного бота и внутреннюю шину. Один POST с JSON
 * закрывает их все, и панели не нужно знать ни одного из них — знание, куда
 * идти, целиком в адресе, который ввёл человек.
 *
 * НАРУЖУ УХОДИТ РОВНО ЗАГОЛОВОК: вид события, его текст и имя папки проекта —
 * та же граница, что у Telegram и у push (`domains/remote-notify.ts`). Ни
 * промпта, ни ответа агента, ни путей внутри проекта: приёмник — чужой сервер,
 * и это решает всё.
 *
 * Подпись обязательна, когда секрет задан: без неё приёмник не отличит панель
 * от любого, кто узнал адрес. Заголовок `X-AgentDeck-Signature` — HMAC-SHA256
 * ТЕЛА в hex, то есть проверяется ровно то, что пришло, а не пересказ.
 */

const SYSTEM = 'Вебхук';
const SIGNATURE_HEADER = 'X-AgentDeck-Signature';
/**
 * Та же подпись под заголовком до переименования продукта: приёмники, настроенные
 * раньше, проверяют именно его. Уходит рядом с новым, значение то же.
 */
const LEGACY_SIGNATURE_HEADER = `X-${LEGACY_BRAND_NAME.replace(' ', '-')}-Signature`;

export interface WebhookDeps {
  settings: () => WebhookSettings;
  /** Секрет подписи из зашифрованного хранилища; нет — шлём без подписи. */
  secret: () => string | undefined;
  /** Куда сообщить о неудачной отправке. Не задан — тишина. */
  onError?: (error: unknown) => void;
}

/** Тело события: то же, что читает человек в Telegram, плюс машинные поля. */
export function composeWebhook(notice: TelegramNotice): WebhookPayload {
  return {
    event: noticeEvent(notice),
    text: compose(notice),
    project: notice.projectPath ? baseName(notice.projectPath) : undefined,
    at: new Date().toISOString(),
  };
}

/** Имя папки без пути — единственное, что панель говорит о проекте. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Отправить одно тело. Возвращает промис — им пользуется кнопка «Проверить
 * связь», которой нужен честный ответ, а не «ушло куда-то».
 */
export async function sendWebhook(
  url: string,
  secret: string | undefined,
  payload: WebhookPayload | (Omit<WebhookPayload, 'event'> & { event: NotifyEvent | 'test' }),
): Promise<void> {
  const target = requireHttpUrl(url);
  const body = JSON.stringify(payload);
  const response = await sendRequest({
    url: target,
    method: 'POST',
    system: SYSTEM,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(secret
        ? { [SIGNATURE_HEADER]: sign(secret, body), [LEGACY_SIGNATURE_HEADER]: sign(secret, body) }
        : {}),
    },
    body,
  });
  if (!response.ok) {
    throw failedResponse(SYSTEM, response, 300);
  }
}

/** Подпись тела: HMAC-SHA256 в hex. */
export function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Адрес приёмника. Только http(s): `file:` увёл бы запрос в файловую систему
 * машины, а прочие схемы панель отправлять не умеет и молчать об этом не должна.
 */
export function requireHttpUrl(url: string): string {
  const value = url.trim();
  if (!value)
    throw invalidField('url', 'не указан адрес вебхука', 'request-webhook-url-missing', {
      field: 'url',
    });
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidField('url', 'адрес вебхука не разобрался', 'request-webhook-url-unparsed', {
      field: 'url',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidField(
      'url',
      'адрес вебхука должен быть http или https',
      'request-webhook-url-scheme',
      { field: 'url' },
    );
  }
  return value;
}

/**
 * Отправитель для реестров прогонов: та же форма, что у Telegram.
 * Выключено, нет адреса или событие не подписано — тишина, без запроса наружу.
 */
export function createWebhookNotifier(deps: WebhookDeps): (notice: TelegramNotice) => void {
  return (notice) => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.url.trim()) return;
    if (!settings.events.includes(noticeEvent(notice))) return;

    void sendWebhook(settings.url, deps.secret(), composeWebhook(notice)).catch(
      (error: unknown) => {
        // Приёмник лёг, адрес переехал, сети нет — событие просто не дошло.
        // Состояние панели от этого не меняется, и падать тут не с чего.
        deps.onError?.(error);
      },
    );
  };
}
