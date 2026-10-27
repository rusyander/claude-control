/**
 * Адрес Bot API. Переменная — шов проверок (`tools/qa/check-group-watch.mjs`
 * поднимает свой приёмник на loopback): настоящий сервер Telegram проверка
 * трогать не должна. Читается при каждой отправке.
 *
 * Принимается только https или http на loopback: токен бота — часть адреса, и
 * открытый http на чужой машине отдал бы его любому на пути. Иное значение —
 * настоящий сервер, как без переменной.
 */
const TELEGRAM_API = 'https://api.telegram.org';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function telegramApiBase(
  raw: string | undefined = process.env.AGENTDECK_TELEGRAM_API,
): string {
  if (!raw) return TELEGRAM_API;
  try {
    const url = new URL(raw);
    const safe =
      url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    return safe ? raw.replace(/\/+$/, '') : TELEGRAM_API;
  } catch {
    return TELEGRAM_API;
  }
}

/**
 * Хвост ответа для подробности отказа — с вырезанным токеном на случай, если
 * Telegram вернул его в тексте ошибки (он это делает, отвечая на битый адрес).
 */
export function safeDetail(text: string): string {
  return text.replace(/bot\d+:[\w-]+/g, 'bot<токен>').slice(0, 300);
}
