import type { PromptId, PromptRecord } from '@agentdeck/contracts/prompts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function resetPrompt(id: PromptId): Promise<PromptRecord> {
  const { data } = await apiClient.delete<PromptRecord>(`/prompts/${id}`);
  return data;
}

/** «Сбросить к встроенному»: правка стирается, карточка приезжает встроенной. */
export function useResetPrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: resetPrompt,
    onSuccess: (record) => {
      queryClient.setQueryData(queryKeys.prompt(record.id), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prompts });
    },
  });
}
