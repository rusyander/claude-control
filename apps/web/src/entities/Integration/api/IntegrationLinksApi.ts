import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationLink, IntegrationLinks } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { integrationKeys } from './keys';

/**
 * Привязки проекта к внешнему миру: куда заводить дефекты, где лежат требования,
 * куда публиковать отчёт.
 *
 * Это единственное, чего агент знать не может сам, — и именно это уходит ему
 * строкой в задании. Хранится по абсолютному пути проекта, а не по его id в
 * реестре: проект в реестре может отсутствовать, а тесты у него всё равно есть.
 *
 * У группы тестов своя привязка поверх проектной: набор «Оплата» ведут в одном
 * эпике, «Профиль» — в другом, а требования лежат на разных страницах.
 */

export function useIntegrationLinks(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: integrationKeys.links(path),
    queryFn: async (): Promise<IntegrationLinks> => {
      const { data } = await apiClient.get<IntegrationLinks>('/integrations/links', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

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
