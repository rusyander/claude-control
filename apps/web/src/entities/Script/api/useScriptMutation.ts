import type { ScriptWriteResult } from './ScriptApi.types';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { scriptsKey } from './ScriptApi.constants';

/**
 * Результат запроса возвращается наружу: общий MutationCache читает из него
 * `backupPath` и называет копию в тосте. Раньше мутации возвращали undefined —
 * и у скриптов, единственных, тост молчал о копии, которую подсказка обещала.
 */
export function useScriptMutation<TInput>(
  request: (input: TInput) => Promise<ScriptWriteResult>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scriptsKey });
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
    },
    meta: { successMessage },
  });
}
