import { serverMessageFromPayload } from '@shared/config/i18n';

/**
 * Отказ режима «решения только с подписью телефона» (`decision_signature_*`):
 * решение до брокера не дошло, вызов всё ещё ждёт. Ответ — текст на языке
 * интерфейса (русский `message` сервера — запасной); не тот отказ — undefined.
 *
 * Отдельно от прочих отказов, потому что действие у человека другое: снятую
 * карточку надо вернуть — с неё ещё можно «Запретить», а «Разрешить» придёт
 * с телефона.
 */
export function signatureRefusalText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  if (!data || typeof data !== 'object') return undefined;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !code.startsWith('decision_signature_')) return undefined;
  return serverMessageFromPayload(data) ?? (typeof message === 'string' ? message : code);
}
