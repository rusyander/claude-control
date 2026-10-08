import { useQuery } from '@tanstack/react-query';
import type { ProviderChatProject } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { providerChatKeys } from './ProviderChatApi.constants';

/**
 * Проекты всех провайдеров одним списком (Claude по его транскриптам, чужие CLI
 * по разговорам панели) — склеивает сервер, здесь только запрос.
 */
export function useProviderChatProjects(enabled = true) {
  return useQuery({
    queryKey: providerChatKeys.projects,
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderChatProject[]>('/provider-chat/projects');
      return data;
    },
    enabled,
  });
}
