import { useQuery } from '@tanstack/react-query';
import type { MediaImagePlan } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { agentQuery } from '../lib/agentQuery';

async function getImagePlan(agent: boolean): Promise<MediaImagePlan> {
  const { data } = await apiClient.get<MediaImagePlan>(`/media/images/plan${agentQuery(agent)}`);
  return data;
}

/**
 * Чем нарисуем. Спрашивается ДО нажатия: пункт «Картинка» обязан быть либо
 * рабочим, либо запертым с причиной, а не отвечать отказом после того, как
 * человек уже описал картинку.
 */
export function useImagePlan(agent: boolean) {
  return useQuery({
    queryKey: queryKeys.mediaImagePlan(agent),
    queryFn: () => getImagePlan(agent),
  });
}
