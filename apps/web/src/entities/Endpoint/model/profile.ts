import type { EndpointApiKind, EndpointProfile } from '@claude-control/contracts';

/**
 * Работа со списком профилей своего эндпоинта на стороне клиента: создание,
 * правка и удаление. Профили — часть настроек панели, поэтому «сохранить»
 * означает отправить обновлённый СПИСОК обычным патчем настроек; отдельного
 * маршрута у них нет намеренно.
 */

/** Виды API в порядке показа. `openai-compat` первый — под него больше всего серверов. */
export const ENDPOINT_API_KINDS: EndpointApiKind[] = ['openai-compat', 'anthropic', 'google'];

/**
 * Подсказка про смысл базового адреса — он разный у видов API, и ошибка здесь
 * стоит человеку получаса: адрес принят, а запросы уходят на несуществующий путь.
 */
export const ENDPOINT_BASE_URL_SAMPLE: Record<EndpointApiKind, string> = {
  'openai-compat': 'http://127.0.0.1:11434/v1',
  anthropic: 'https://gateway.example.com',
  google: 'https://gateway.example.com',
};

/** Новый профиль с заполненными по умолчанию полями. */
export function newEndpointProfile(id: string, name: string): EndpointProfile {
  return { id, name, baseUrl: '', apiKind: 'openai-compat', model: '', writeToken: false };
}

/** Заменить профиль в списке по id (не мутируя исходный массив). */
export function replaceProfile(
  profiles: EndpointProfile[],
  profile: EndpointProfile,
): EndpointProfile[] {
  return profiles.map((item) => (item.id === profile.id ? profile : item));
}

/** Убрать профиль из списка по id. */
export function removeProfile(profiles: EndpointProfile[], id: string): EndpointProfile[] {
  return profiles.filter((item) => item.id !== id);
}

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
