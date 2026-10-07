import { useQuery } from '@tanstack/react-query';
import type { GroupDelivery } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Что группа дала бы прогону этого CLI — без записи на диск (`GET
 * /api/groups/:id/delivery`). Ключ — под `groups`: правка группы или её
 * тумблера перечитывает и этот вид.
 */
export function useGroupDelivery(id: string, provider: string | undefined) {
  return useQuery({
    queryKey: queryKeys.groupDelivery(id, provider ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<GroupDelivery>(`/groups/${id}/delivery`, {
        params: { provider },
      });
      return data;
    },
    enabled: Boolean(provider),
    retry: false,
  });
}
