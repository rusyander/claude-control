import { useT } from '../../shared/config/i18n';
import { useCallback } from 'react';
import { localizeMediaTitle } from '@agentdeck/contracts/chat-title';

/**
 * Слово режима в названии («Картинка: …») сервер пишет по-русски — одно
 * название на все клиенты; телефон ставит слово своего языка.
 */
export function useLocalTitle(): <T extends { title: string }>(chat: T) => T {
  const t = useT();
  return useCallback(
    <T extends { title: string }>(chat: T): T => {
      const title = localizeMediaTitle(chat.title, (mode) => t.chat.titleWord[mode]);
      return title === chat.title ? chat : { ...chat, title };
    },
    [t],
  );
}
