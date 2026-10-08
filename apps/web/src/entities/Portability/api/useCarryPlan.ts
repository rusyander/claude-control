import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import type { CarryPlan } from '@agentdeck/contracts/portable-carry';
import { apiClient } from '@shared/api/client';

/**
 * Незакрытая работа, которую панель предлагает перенести к новому CLI (П6.1).
 *
 * Запрос за ресурсом, а не мутация: список ничего не заводит и не запускает —
 * он только читает разговоры и считает по ним предохранители. Свежесть нужна
 * настоящая (разговор мог закрыться минуту назад), поэтому кэш здесь короткий.
 */
export function useCarryPlan() {
  return useQuery({
    queryKey: queryKeys.portabilityCarry,
    queryFn: async (): Promise<CarryPlan> => {
      const { data } = await apiClient.get<CarryPlan>('/portability/carry');
      return data;
    },
    staleTime: 15_000,
  });
}
