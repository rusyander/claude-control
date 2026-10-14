import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LocalChoiceBody,
  LocalChoiceResult,
  LocalModelsInfo,
} from '@agentdeck/contracts/local-models';
import { queryKeys } from '@shared/api/query-keys';
import { put } from '../lib/put';
import { withChoice } from '../model/withChoice';

/**
 * Выбор квантования и окна для модели. Запоминается на сервере и действует на
 * каждый запуск; идущий сервер перезапускается, если выбор его меняет. Строка
 * перерисовывается сразу — не ждёт ответа: два связанных списка, где второй
 * пересчитывается от первого, при задержке выглядели бы сломанными.
 */
export function useSetModelChoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LocalChoiceBody) => put<LocalChoiceResult>('/local-models/choice', body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.localModels });
      const before = queryClient.getQueryData<LocalModelsInfo>(queryKeys.localModels);
      if (before) queryClient.setQueryData(queryKeys.localModels, withChoice(before, body));
      return { before };
    },
    onError: (_error, _body, context) => {
      if (context?.before) queryClient.setQueryData(queryKeys.localModels, context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.localModels }),
  });
}
