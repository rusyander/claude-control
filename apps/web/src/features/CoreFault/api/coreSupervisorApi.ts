import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Пока ядро поднимается или упало, состояние надзора перечитывается так часто. */
export const SUPERVISOR_POLL_MS = 2_000;

/**
 * Состояние надзора панели за ядром (`/api/core/supervisor`, этап 10). `null` — надзор выключен
 * (`AGENTDECK_CORE_SUPERVISE=0`): ядро поднимает тот, кто его выключил. `poll` — карточка
 * отказа на экране: ждём подъёма ядра опросом, а не кнопкой «обновить».
 */
export function useCoreSupervisor(poll: boolean) {
  return useQuery({
    queryKey: queryKeys.core.supervisor,
    queryFn: async () =>
      (await apiClient.get<CoreSupervisorStatus | null>('/core/supervisor')).data ?? null,
    refetchInterval: (query) =>
      poll && query.state.data !== null && query.state.data?.state !== 'up'
        ? SUPERVISOR_POLL_MS
        : false,
    retry: false,
  });
}

/** «Перезапустить» карточки сбоя: счёт неудач с нуля, подъём сразу; всё ядро перечитывается. */
export function useRestartCore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await apiClient.post<CoreSupervisorStatus>('/core/supervisor/restart')).data,
    onSuccess: (status) => {
      client.setQueryData(queryKeys.core.supervisor, status);
      void client.invalidateQueries({ queryKey: queryKeys.core.all });
    },
  });
}

/** Автозапуск ядра при входе в систему (Планировщик задач, systemd, LaunchAgent). */
export function useCoreAutostart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (on: boolean) =>
      (
        await apiClient.post<{ ok: boolean; state: CoreSupervisorStatus['autostart'] }>(
          '/core/supervisor/autostart',
          { on },
        )
      ).data,
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.core.supervisor }),
  });
}
