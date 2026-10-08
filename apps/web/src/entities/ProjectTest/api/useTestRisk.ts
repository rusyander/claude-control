import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestRiskReport } from '@agentdeck/contracts';

/**
 * Риск кейсов: чем гнать, если времени на всё нет.
 *
 * Бюджет («у меня N минут») в запрос НЕ уходит, хотя сервер его умеет: на экране
 * его применяют к видимому отбору — к той сотне кейсов, которую человек уже
 * сузил фильтром, — и лишний поход на сервер на каждое изменение числа минут
 * означал бы очередь запросов там, где считается одно сложение.
 */
export function useTestRisk(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.risk(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestRiskReport>('/project-tests/risk', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
