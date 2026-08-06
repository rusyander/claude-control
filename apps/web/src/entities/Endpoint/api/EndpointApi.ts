import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EndpointApplyResult,
  EndpointProbeResult,
  EndpointsInfo,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getEndpoints(profileId: string): Promise<EndpointsInfo> {
  const { data } = await apiClient.get<EndpointsInfo>('/endpoints', {
    params: profileId ? { profile: profileId } : undefined,
  });
  return data;
}

async function probe(profileId: string): Promise<EndpointProbeResult> {
  const { data } = await apiClient.post<EndpointProbeResult>(
    `/endpoints/${encodeURIComponent(profileId)}/probe`,
  );
  return data;
}

async function apply(input: { profileId: string; provider: string }): Promise<EndpointApplyResult> {
  const { data } = await apiClient.post<EndpointApplyResult>(
    `/endpoints/${encodeURIComponent(input.profileId)}/apply`,
    { provider: input.provider },
  );
  return data;
}

async function saveToken(input: { profileId: string; token: string }): Promise<void> {
  await apiClient.put(`/endpoints/${encodeURIComponent(input.profileId)}/token`, {
    token: input.token,
  });
}

async function clearToken(profileId: string): Promise<void> {
  await apiClient.delete(`/endpoints/${encodeURIComponent(profileId)}/token`);
}

/**
 * Профили своего эндпоинта, маски токенов и готовность каждого CLI. Сервер
 * только читает настройки и реестр — в сеть этот запрос НЕ ходит, поэтому его
 * можно звать при каждом открытии настроек.
 */
export function useEndpoints(profileId: string) {
  return useQuery({
    queryKey: queryKeys.endpoints(profileId),
    queryFn: () => getEndpoints(profileId),
  });
}

/**
 * Проверка связи — отдельной кнопкой: она ходит по сети к чужому адресу. Ответ
 * несёт список моделей, из которого пользователь выбирает имя модели.
 */
export function useProbeEndpoint() {
  return useMutation({ mutationFn: probe });
}

/** Запись профиля в конфигурацию выбранного CLI. */
export function useApplyEndpoint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: apply,
    onSuccess: () => {
      // Запись меняет файл конфигурации: обновляем разделы окружения и ленту
      // изменений — иначе панель показывала бы состояние до записи.
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
  });
}

/** Сохранить токен профиля. Наружу он больше не вернётся — только маской. */
export function useSaveEndpointToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['endpoints'] }),
  });
}

/** Забыть токен профиля. */
export function useClearEndpointToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: clearToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['endpoints'] }),
  });
}
