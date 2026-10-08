import type { EndpointApiKind, EndpointProfile } from '@agentdeck/contracts';

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
  return {
    id,
    name,
    baseUrl: '',
    apiKind: 'openai-compat',
    model: '',
    writeToken: false,
    // Адрес генерации картинок пуст: угадывать его из базового нельзя —
    // совместимый сервер вправе не иметь этой ручки вовсе (решение В4).
    imagesUrl: '',
    // Профиль, заведённый человеком, никому не принадлежит: управляемые
    // порождает контур, и только сервер (Т3).
    ownerPlatformId: '',
  };
}
