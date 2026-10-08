import type { CarryApplyAnswer } from '@agentdeck/contracts/portable-carry';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function postCarryApply(keys: string[]): Promise<CarryApplyAnswer> {
  const { data } = await apiClient.post<CarryApplyAnswer>('/portability/carry/apply', { keys });
  return data;
}

/**
 * Перенести выбранное. Список после этого обязан перечитаться: перенесённый
 * разговор перестаёт быть кандидатом (его опора уже отмечена), а у цели
 * появился новый — и он, в свою очередь, кандидатом не является.
 */
export function useApplyCarry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postCarryApply,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilityCarry });
    },
  });
}
