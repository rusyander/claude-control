import type { MediaDeck } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function createDeck(request: {
  chatId: string;
  prompt: string;
  /** Правка готовой колоды: её структура уедет модели вместе с просьбой. */
  reviseOf?: string;
}): Promise<MediaDeck> {
  const { data } = await apiClient.post<MediaDeck>('/media/decks', request, {
    timeout: LONG_TIMEOUTS.mediaDeck,
  });
  return data;
}

export function useCreateDeck() {
  return useMutation({ mutationFn: createDeck });
}
