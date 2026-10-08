import type { ChatAutoModeView } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Авторежим прав этого чата глазами сервера: выбор чата, иначе глобальная
 * настройка панели. Без него переключатель показывал бы «вкл» из коробки, даже
 * когда в панели авторежим выключен, — телефон врал бы о том, что сейчас будет.
 */
export function chatAutoModeQuery(
  chatId: string,
  sessionId?: string,
): { queryKey: unknown[]; queryFn: () => Promise<ChatAutoModeView> } {
  return {
    queryKey: ['chat', chatId, 'auto-mode', sessionId ?? ''],
    queryFn: () =>
      api.get<ChatAutoModeView>(`/chat/${encodeURIComponent(chatId)}/auto-mode`, { sessionId }),
  };
}
