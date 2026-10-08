import type { EndpointProfile } from '@agentdeck/contracts';

/**
 * Готов ли профиль к применению: адрес обязателен и обязан быть http(s).
 * Проверка та же, что на сервере, — здесь она нужна лишь затем, чтобы кнопка
 * не отправляла заведомо отвергаемое.
 */
export function isProfileComplete(profile: EndpointProfile): boolean {
  const url = profile.baseUrl.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
