import type { ModelCatalogResponse } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function refreshModels(): Promise<ModelCatalogResponse> {
  const { data } = await apiClient.get<ModelCatalogResponse>('/models?refresh=true');
  return data;
}

/** Ручное обновление по кнопке: всегда идёт в сеть. */
export function useRefreshModels() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshModels,
    onSuccess: (catalog) => {
      queryClient.setQueryData(queryKeys.models, catalog);
      // Автозамена дефолта меняет настройки на сервере — перечитываем их.
      if (catalog.promoted) void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
