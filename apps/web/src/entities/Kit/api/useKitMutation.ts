import type { KitResponse } from '@agentdeck/contracts/kit';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Каждая правка отвечает свежим набором целиком: его и кладём в кэш, а текст
 * элемента перечитываем — копия «моё» могла появиться или уйти в архив.
 */
export function useKitMutation<TInput>(run: (input: TInput) => Promise<KitResponse>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (kit) => queryClient.setQueryData(queryKeys.kit, kit),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.kit }),
  });
}
