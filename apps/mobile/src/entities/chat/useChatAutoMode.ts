import type { UseQueryResult } from '@tanstack/react-query';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { chatAutoModeQuery } from './chatAutoModeQuery';
import { STALE_MS } from './api.constants';

export function useChatAutoMode(
  chatId: string,
  sessionId?: string,
): UseQueryResult<ChatAutoModeView> {
  return useQuery({
    ...chatAutoModeQuery(chatId, sessionId),
    enabled: Boolean(chatId),
    staleTime: STALE_MS,
  });
}
