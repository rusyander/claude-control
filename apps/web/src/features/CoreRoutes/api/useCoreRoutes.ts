import { useQuery } from '@tanstack/react-query';
import type { RoutesReply } from '@agentdeck/contracts/core/panel-api';
import { coreGet } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';

/** Маршруты моделей ядра (`GET /v1/routes`): виды, доступ без значений, цена, предел. */
export function useCoreRoutes() {
  return useQuery({
    queryKey: queryKeys.core.routes,
    queryFn: () => coreGet<RoutesReply>('/routes'),
    retry: false,
  });
}
