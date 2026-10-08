import type { Platform } from '@agentdeck/contracts';

/**
 * Что уедет на сервер. Пустое поле ключа значит «не трогали»: в теле его тогда
 * нет вовсе, и сохранённый ключ остаётся на месте. Пустая строка в теле стёрла
 * бы его — а человек всего лишь правил название.
 */
export function savePayload(
  platform: Platform,
  token: string,
): { platform: Platform; token?: string } {
  const trimmed = { ...platform, baseUrl: platform.baseUrl.trim() };
  return token ? { platform: trimmed, token } : { platform: trimmed };
}
