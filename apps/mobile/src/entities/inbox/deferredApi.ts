import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ChatInbox, InboxDeferred } from '@agentdeck/contracts/chat-inbox';
import type { DeferredDecisionResult } from '@agentdeck/contracts/deferred-asks';
import { api } from '../../shared/api/client';
import { INBOX_POLL_MS } from './api';
import { inboxQuery } from './inboxQuery';
import { deferredDecisionBody, deferredDecisionPath } from './deferred';

function selectDeferred(inbox: ChatInbox): InboxDeferred[] {
  return inbox.deferred ?? [];
}

/**
 * Записи D-n из той же сводки, что и чаты главной: один запрос и один опрос на
 * экран, `select` берёт только своё поле. Нет поля — старый сервер, список пуст.
 */
export function useInboxDeferred(enabled = true): UseQueryResult<InboxDeferred[]> {
  return useQuery({
    ...inboxQuery(),
    enabled,
    select: selectDeferred,
    refetchInterval: INBOX_POLL_MS,
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
}

export interface DeferredDecision {
  id: string;
  behavior: 'allow' | 'deny';
}

/** Решение по записи; после него сводка перечитывается — запись уходит из списка. */
export function useDecideDeferred(): UseMutationResult<
  DeferredDecisionResult,
  Error,
  DeferredDecision
> {
  const queryClient = useQueryClient();
  return useMutation<DeferredDecisionResult, Error, DeferredDecision>({
    mutationFn: ({ id, behavior }) =>
      api.post<DeferredDecisionResult>(deferredDecisionPath(id), deferredDecisionBody(behavior)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: inboxQuery().queryKey }),
  });
}
