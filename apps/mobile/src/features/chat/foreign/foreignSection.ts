import type { ProvidersResponse } from '@agentdeck/contracts';

/** Активный CLI, чьи разговоры показывает секция: id для запросов и имя для подписи. */
export interface ForeignSectionProvider {
  id: string;
  name: string;
}

/**
 * Показывать ли секцию разговоров чужого CLI и от чьего имени. Чистая часть
 * `ForeignChatsSection`, чтобы проверяться тестом, а не глазами на устройстве.
 *
 * Секции нет, когда активен Claude (у него свой чат ниже) и когда чат у
 * активного CLI не готов (`capabilities.chat`): у Cursor нет неинтерактивного
 * запуска, сервер отказывает `provider-chat-unsupported`, и кнопка «Новый
 * разговор» обещала бы то, чего не будет. Карточки активного CLI в ответе нет —
 * тоже не показываем: решать по одному id значило бы угадывать.
 */
export function foreignChatSection(
  providers: ProvidersResponse | undefined,
): ForeignSectionProvider | undefined {
  const active = providers?.active;
  if (!active || active === 'claude') return undefined;
  const card = providers.providers.find((provider) => provider.id === active);
  if (card?.capabilities.chat !== 'ready') return undefined;
  return { id: active, name: card.name };
}
