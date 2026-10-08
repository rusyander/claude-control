import type { UseQueryResult } from '@tanstack/react-query';
import type { ProviderChatDetail } from '@agentdeck/contracts';
import { useQuery } from '@tanstack/react-query';
import { foreignKeys } from './api.constants';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/**
 * Разговор целиком. `provider` уходит всегда: разговор, открытый по уведомлению,
 * мог принадлежать CLI, который уже не активен, — сервер отдаёт его на чтение.
 */
export function useForeignChat(
  providerId: string,
  chatId: string,
): UseQueryResult<ProviderChatDetail> {
  return useQuery({
    queryKey: foreignKeys.chat(providerId, chatId),
    queryFn: () =>
      api.get<ProviderChatDetail>(`/provider-chat/chats/${encodeURIComponent(chatId)}`, {
        provider: providerId,
      }),
    enabled: isConfigured() && Boolean(chatId),
  });
}
