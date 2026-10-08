import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import type { ProviderPermissionInfo } from '@agentdeck/contracts';

// --- Права/аппрувы проекта -------------------------------------------------
// GEMINI-2: `<проект>/.gemini/settings.json`; OPENCODE-1: ключ `permission` в
// `<проект>/opencode.json`. Модель выбирает СЕРВЕР (поле `kind`), клиент только
// рисует нужную форму — поэтому тип ответа общий (`ProviderPermissionInfo`).

export function useProviderProjectPermissions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderPermissions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderPermissionInfo>(
        `/projects/${projectId}/provider/permissions`,
      );
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}
