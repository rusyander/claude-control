import { useQueryClient, useMutation } from '@tanstack/react-query';
import { setCascadeRuleOptions } from '../lib/setCascadeRuleOptions';

/** Запись правила проекта; что и как пишется — в `setCascadeRuleOptions`. */
export function useSetCascadeRule(path: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation(setCascadeRuleOptions(queryClient, path));
}
