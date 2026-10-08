import type { PromptId, PromptRecord } from '@agentdeck/contracts/prompts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function savePrompt(input: { id: PromptId; text: string }): Promise<PromptRecord> {
  const { data } = await apiClient.put<PromptRecord>(`/prompts/${input.id}`, { text: input.text });
  return data;
}

/** Сохранение правки. Ответ — уже новая карточка, поэтому кладём её сразу. */
export function useSavePrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: savePrompt,
    onSuccess: (record) => {
      queryClient.setQueryData(queryKeys.prompt(record.id), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prompts });
    },
  });
}
