import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { IntegrationLinks } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

export function useRemoveIntegrationLink(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (groupId: string | undefined): Promise<IntegrationLinks> => {
      // DELETE с телом: адресуемся не идентификатором в пути, а парой
      // «проект + группа», и запихивать абсолютный путь в адрес незачем.
      const { data } = await apiClient.delete<IntegrationLinks>('/integrations/links', {
        data: { path, groupId },
      });
      return data;
    },
    onSuccess: (data) => client.setQueryData(integrationKeys.links(path), data),
    meta: { successMessage: 'toasts.deleted' },
  });
}
