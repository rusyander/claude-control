import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ComposeInfo } from '@agentdeck/contracts';
import type { ComposeActionBody } from '@agentdeck/contracts/request-bodies';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Действие над стеком или сервисом. Ответ — уже новое состояние с идущим
 * действием: кладём его в кэш сразу, не дожидаясь следующего опроса. Отказы
 * показывает само окно (у них свой `code`), общий тост не нужен.
 */
export function useComposeAction() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: ComposeActionBody) => {
      const { data } = await apiClient.post<ComposeInfo>('/compose/action', body);
      return data;
    },
    onSuccess: (data, body) => {
      queryClient.setQueryData(queryKeys.compose(body.path), data);
    },
    onError: (_error, body) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.compose(body.path) });
    },
  });
}
