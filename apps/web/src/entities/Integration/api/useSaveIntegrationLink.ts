import type { IntegrationLink, IntegrationLinks } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

export interface SaveIntegrationLinkPayload {
  /** Пусто — привязка самого проекта, иначе привязка группы тестов. */
  groupId?: string;
  link: IntegrationLink;
}

export function useSaveIntegrationLink(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      groupId,
      link,
    }: SaveIntegrationLinkPayload): Promise<IntegrationLinks> => {
      const { data } = await apiClient.put<IntegrationLinks>('/integrations/links', {
        path,
        groupId,
        link,
      });
      return data;
    },
    onSuccess: (data) => client.setQueryData(integrationKeys.links(path), data),
    meta: { successMessage: 'toasts.saved' },
  });
}
