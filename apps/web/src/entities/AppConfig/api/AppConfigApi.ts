import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, ClaudeLocation, Overview } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getLocation(): Promise<ClaudeLocation> {
  const { data } = await apiClient.get<ClaudeLocation>('/location');
  return data;
}

async function setLocation(path: string): Promise<ClaudeLocation> {
  const { data } = await apiClient.post<ClaudeLocation>('/location', { path });
  return data;
}

async function getSettings(): Promise<AppSettings> {
  const { data } = await apiClient.get<AppSettings>('/settings');
  return data;
}

async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const { data } = await apiClient.patch<AppSettings>('/settings', patch);
  return data;
}

async function getOverview(): Promise<Overview> {
  const { data } = await apiClient.get<Overview>('/overview');
  return data;
}

// Хуки: компоненты работают только с ними.

export function useLocation() {
  return useQuery({ queryKey: queryKeys.location, queryFn: getLocation });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: getSettings });
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: getOverview });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchSettings,
    onSuccess: (settings) => {
      // Настройки кладём в кеш напрямую: тема и язык должны примениться
      // мгновенно, без ожидания повторного запроса.
      queryClient.setQueryData(queryKeys.settings, settings);
    },
  });
}

export function useSetLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setLocation,
    onSuccess: () => {
      // Смена каталога меняет вообще всё, что показывает приложение.
      void queryClient.invalidateQueries();
    },
    meta: { successMessage: 'toasts.locationChanged' },
  });
}
