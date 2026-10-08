import type { MediaDeck } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/** Колода из блока агента: сборка файлов идёт на сервере, поэтому свой потолок. */
export async function saveDeck(request: {
  chatId: string;
  prompt: string;
  block: string;
  model: string;
  /**
   * Колода, которую этот блок заменяет. Без неё правка потеряла бы картинки
   * прежней колоды: панель принимает их имена только из ЕЁ набора.
   */
  reviseOf?: string;
}): Promise<MediaDeck> {
  const { data } = await apiClient.post<MediaDeck>('/media/decks/block', request, {
    timeout: LONG_TIMEOUTS.mediaDeck,
  });
  return data;
}

export function useSaveDeck() {
  return useMutation({ mutationFn: saveDeck });
}
