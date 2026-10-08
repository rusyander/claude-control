import type { IntegrationStatus } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { integrationKeys } from './keys';
import { queryKeys } from '@shared/api/query-keys';

/** Общая часть команд: ответ — статус коннектора, и он же обновляет настройки. */
export function useIntegrationMutation<TVariables>(
  send: (variables: TVariables) => Promise<IntegrationStatus>,
  successMessage?: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: integrationKeys.root });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
    meta: successMessage ? { successMessage } : undefined,
  });
}
