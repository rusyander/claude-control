import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutsideRelayState } from '@agentdeck/contracts/chat-inbox';
import type { MobileApkInstallResult, MobileApkStatus } from '@agentdeck/contracts/mobile-apk';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/** Идёт сборка — вывод обновляется часто; иначе только ради списка телефонов adb. */
const BUILDING_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

export function useMobileApk() {
  return useQuery({
    queryKey: queryKeys.mobileApk,
    queryFn: async () => (await apiClient.get<MobileApkStatus>('/mobile/apk')).data,
    refetchInterval: (query) =>
      query.state.data?.state === 'building' ? BUILDING_POLL_MS : IDLE_POLL_MS,
  });
}

export function useBuildMobileApk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await apiClient.post<MobileApkStatus>('/mobile/apk/build')).data,
    // Отказ показывает карточка своим тостом — общий тост MutationCache молчит.
    meta: { silentError: true },
    onSuccess: (status) => queryClient.setQueryData(queryKeys.mobileApk, status),
  });
}

export function useInstallMobileApk() {
  return useMutation({
    mutationFn: async (device: string) =>
      (await apiClient.post<MobileApkInstallResult>('/mobile/apk/install', { device })).data,
    meta: { silentError: true },
  });
}

export function useOutsideRelay() {
  return useQuery({
    queryKey: queryKeys.outsideRelay,
    queryFn: async () => (await apiClient.get<OutsideRelayState>('/outside/relay')).data,
    // Хук человек ставит в разделе «Хуки» — «не установлен» должен смениться сам.
    refetchInterval: IDLE_POLL_MS,
  });
}

export function useToggleOutsideRelay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      (await apiClient.patch<OutsideRelayState>('/outside/relay', { enabled })).data,
    onSuccess: (state) => queryClient.setQueryData(queryKeys.outsideRelay, state),
  });
}
