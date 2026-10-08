import type { PortabilityLevel } from './PortabilityApi.types';
import type { FidelityAnswer } from '@agentdeck/contracts/portable-fidelity';
import { apiClient } from '@shared/api/client';
import { levelParams } from '../lib/levelParams';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getFidelity(
  provider: string,
  target: string,
  level: PortabilityLevel,
): Promise<FidelityAnswer> {
  const { data } = await apiClient.get<FidelityAnswer>('/portability/fidelity', {
    params: { provider, target, ...levelParams(level) },
  });
  return data;
}

/**
 * Отчёт верности переноса «источник → цель». Запрашивается ДО всякого
 * применения: строка «работает только при запуске через панель» обязана быть
 * видна человеку раньше, чем он решится переносить.
 *
 * Цель не выбрана — запроса нет вовсе (`enabled`), а не запрос «куда-нибудь»:
 * отчёт о цели по умолчанию отвечал бы на вопрос, которого не задавали.
 */
export function useFidelityReport(provider: string, target: string, level: PortabilityLevel) {
  return useQuery({
    queryKey: queryKeys.portabilityFidelity(provider, target, level.scope, level.project),
    queryFn: () => getFidelity(provider, target, level),
    enabled: Boolean(provider && target) && (level.scope === 'global' || Boolean(level.project)),
  });
}
