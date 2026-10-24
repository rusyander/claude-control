import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeferredAskList, DeferredDecisionResult } from '@agentdeck/contracts/deferred-asks';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { DEFERRED_REFETCH_MS } from '../model/deferredAsk.constants';

/**
 * Отложенные вопросы D-n (`GET /api/chat/deferred`): один список на все чаты и
 * группы. Освежает его рассылка `chat-deferred` после каждой записи (`DOMAIN_KEYS`);
 * опрос раз в минуту — страховка на случай потерянного события: срок записи
 * истекает на сервере по часам, а не по записи.
 */
export function useDeferredAsks() {
  return useQuery({
    queryKey: queryKeys.chatDeferred,
    queryFn: async (): Promise<DeferredAskList> => {
      const { data } = await apiClient.get<DeferredAskList>('/chat/deferred');
      return data;
    },
    refetchInterval: DEFERRED_REFETCH_MS,
  });
}

export interface DecideDeferredInput {
  id: string;
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * Решение человека по D-n. Маршрут принимает его только от человека (процесс
 * модели получает 403), `via` — подпись для истории, а не право.
 */
export function useDecideDeferredAsk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, behavior, message }: DecideDeferredInput) => {
      const { data } = await apiClient.post<DeferredDecisionResult>(
        `/chat/deferred/${encodeURIComponent(id)}/decision`,
        { behavior, via: 'web', ...(message ? { message } : {}) },
      );
      return data;
    },
    // Отказ называет вызывающий своим тостом — общий тост клиента дал бы второй.
    meta: { silentError: true },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatDeferred });
      void queryClient.invalidateQueries({ queryKey: ['chat-tree'] });
    },
  });
}
