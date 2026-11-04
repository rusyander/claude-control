import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { withEconomyLever, type CoreEconomyValues } from './coreEconomy';

/** Действующая настройка ядра с отпечатком; ключ общий с экраном запуска — кэш один. */
export function useCoreEconomyConfig() {
  return useQuery({
    queryKey: queryKeys.core.config,
    queryFn: () => coreGet<ConfigView>('/config'),
    retry: false,
  });
}

export interface SaveEconomyInput<K extends keyof CoreEconomyValues = keyof CoreEconomyValues> {
  view: ConfigView;
  lever: K;
  value: CoreEconomyValues[K];
}

/**
 * Запись рычага в настройку ядра (`set-config`, строгий суд полномочий: настройка машинная, шире
 * любой задачи). Поле сразу показывает новое значение (иначе управляемый выбор отскакивал бы к
 * старому, пока идёт запись), ответ ядра кладёт действующий документ, отказ возвращает прежний;
 * после — настройка перечитывается.
 */
export function useSaveCoreEconomy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ view, lever, value }: SaveEconomyInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const { doc, baseDigest } = withEconomyLever(view, lever, value);
      return corePost<SetConfigReply>('/config', {
        cmdId: newUuidv7(),
        doc,
        baseDigest,
        proof: { nonce, page },
      });
    },
    onMutate: async ({ view, lever, value }: SaveEconomyInput) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.core.config });
      const { doc } = withEconomyLever(view, lever, value);
      queryClient.setQueryData<ConfigView>(queryKeys.core.config, { ...view, doc });
      return { previous: view };
    },
    onSuccess: (reply) => queryClient.setQueryData(queryKeys.core.config, reply.view),
    onError: (_error, _input, context) => {
      if (context) queryClient.setQueryData(queryKeys.core.config, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.config }),
  });
}
