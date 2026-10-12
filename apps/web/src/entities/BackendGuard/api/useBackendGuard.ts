import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { BackendGuardCheck, BackendGuardStatus } from '@agentdeck/contracts';
import type {
  BackendGuardCheckBody,
  BackendGuardInstallBody,
  BackendGuardSettingsBody,
} from '@agentdeck/contracts/request-bodies';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Защита бэкенда проекта. Состояние читает файлы `.claude/` проекта — опрос не
 * нужен, только при открытии вкладки. Установка и снятие заводят и удаляют
 * проектную группу, поэтому сбрасывают и список групп.
 */

export function useBackendGuard(path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.backendGuard(path),
    queryFn: async () => {
      const { data } = await apiClient.get<BackendGuardStatus>('/backend-guard', {
        params: { path },
      });
      return data;
    },
    enabled: enabled && Boolean(path),
    retry: false,
  });
}

function useGuardWrite<Body extends { path: string }>(
  method: 'post' | 'put',
  url: string,
  touchesGroups: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: Body) => {
      const { data } = await apiClient[method]<BackendGuardStatus>(url, body);
      return data;
    },
    onSuccess: (data, body) => {
      queryClient.setQueryData(queryKeys.backendGuard(body.path), data);
      if (touchesGroups) void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    },
    // Отказ (защиту сняли в другом окне, файл пропал) — состояние на экране уже неправда.
    onError: (_error, body) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backendGuard(body.path) });
    },
  });
}

/** Поставить или восстановить: файлы хука и правила кладутся заново. */
export const useInstallBackendGuard = () =>
  useGuardWrite<BackendGuardInstallBody>('post', '/backend-guard/install', true);

export const useSaveBackendGuardSettings = () =>
  useGuardWrite<BackendGuardSettingsBody>('put', '/backend-guard/settings', false);

export const useRemoveBackendGuard = () =>
  useGuardWrite<{ path: string }>('post', '/backend-guard/remove', true);

/** «Проверить команду» по настройкам формы — у каждой проверки свой ответ. */
export function useCheckBackendGuard() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: BackendGuardCheckBody) => {
      const { data } = await apiClient.post<BackendGuardCheck>('/backend-guard/check', body);
      return data;
    },
  });
}
