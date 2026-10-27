import { agentRuns } from '@shared/lib/agent-runs';
import { useChatAutoMode, useSetChatAutoMode } from '@entities/ChatAutoMode';

/**
 * Авторежим прав открытого чата. Положение — с сервера: выбор человека в чате
 * сильнее глобальной настройки, не выбирал — чат идёт за ней. В отправку уходит
 * только выбор чата (`override`); без него сервер сам возьмёт глобальную.
 * Вынесено из `ChatPage` без изменений.
 */
export function useChatAutoApprove(
  chatId: string | undefined,
  sessionId: string | undefined,
  globalDefault: boolean | undefined,
) {
  const autoMode = useChatAutoMode(chatId, sessionId);
  const setChatAutoMode = useSetChatAutoMode();
  // Щелчок — выбор ЭТОГО чата, сервер его запоминает, и он сильнее глобальной
  // настройки. Идущему прогону — тут же, в том числе под ключом, которым его
  // завела другая вкладка, — иначе тумблер подействовал бы только со следующего
  // сообщения.
  const toggle = (enabled: boolean): void => {
    if (!chatId) return;
    setChatAutoMode.mutate({ chatId, enabled });
    agentRuns.setAutoApprove(chatId, enabled);
  };
  return {
    autoApprove: autoMode.data?.enabled ?? globalDefault ?? true,
    override: autoMode.data?.override,
    toggle,
  };
}
