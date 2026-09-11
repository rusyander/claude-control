import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptId, PromptRecord, PromptSummary } from '@agentdeck/contracts/prompts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Каталог промптов приложения.
 *
 * Список и карточка — два разных запроса намеренно: в списке пять строк с
 * размером и состоянием, а в карточке два текста по несколько килобайт, и
 * тянуть их ради экрана со списком незачем. Открытая карточка своим запросом и
 * обновляется.
 */

async function getPrompts(): Promise<PromptSummary[]> {
  const { data } = await apiClient.get<{ items: PromptSummary[] }>('/prompts');
  return data.items;
}

async function getPrompt(id: PromptId): Promise<PromptRecord> {
  const { data } = await apiClient.get<PromptRecord>(`/prompts/${id}`);
  return data;
}

async function savePrompt(input: { id: PromptId; text: string }): Promise<PromptRecord> {
  const { data } = await apiClient.put<PromptRecord>(`/prompts/${input.id}`, { text: input.text });
  return data;
}

async function resetPrompt(id: PromptId): Promise<PromptRecord> {
  const { data } = await apiClient.delete<PromptRecord>(`/prompts/${id}`);
  return data;
}

export function usePrompts() {
  return useQuery({ queryKey: queryKeys.prompts, queryFn: getPrompts });
}

export function usePrompt(id: PromptId | undefined) {
  return useQuery({
    queryKey: queryKeys.prompt(id ?? ''),
    queryFn: () => getPrompt(id as PromptId),
    enabled: Boolean(id),
  });
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
