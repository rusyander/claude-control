import type { ProjectTestPlan } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';

/** Общая часть правок плана: ответ сервера — новый список планов целиком. */
export function usePlanMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestPlan[]>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (plans) => {
      client.setQueryData(testKeys.plans(path), plans);
      // Список кейсов держит планы в своём ответе, а число поинтов считается по
      // плану — обе ветки после правки устарели.
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
      void client.invalidateQueries({ queryKey: testKeys.points(path, undefined) });
    },
  });
}
