import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GlobalLayerApplyRequest,
  GlobalLayerApplyResponse,
  GlobalLayerPairView,
  GlobalLayerProposal,
  GlobalLayerResponse,
  GlobalLayerTransferRequest,
  GlobalLayerTransferResponse,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getPairs(): Promise<GlobalLayerResponse> {
  const { data } = await apiClient.get<GlobalLayerResponse>('/global-layer');
  return data;
}

async function getProposal(id: string): Promise<GlobalLayerProposal> {
  const { data } = await apiClient.get<GlobalLayerProposal>(`/global-layer/${id}/proposal`);
  return data;
}

/**
 * Пока идёт сверка, карточка опрашивает раз в две секунды: конец сверки сервер
 * и так разошлёт, но при выключенном наблюдении за файлами рассылки нет.
 */
const COMPARING_INTERVAL_MS = 2000;

export function useGlobalLayer() {
  return useQuery({
    queryKey: queryKeys.globalLayer,
    queryFn: getPairs,
    refetchInterval: (query) =>
      query.state.data?.pairs.some((pair) => pair.comparing) ? COMPARING_INTERVAL_MS : false,
  });
}

export function useGlobalProposal(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.globalLayer, id, 'proposal'],
    queryFn: () => getProposal(id),
    enabled,
  });
}

function useLayerAction<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.globalLayer }),
  });
}

export const useCompareGlobalLayer = () =>
  useLayerAction<string, GlobalLayerPairView>(async (id) => {
    const { data } = await apiClient.post<GlobalLayerPairView>(`/global-layer/${id}/compare`, {});
    return data;
  });

export const useApplyGlobalProposal = () =>
  useLayerAction<{ id: string; body: GlobalLayerApplyRequest }, GlobalLayerApplyResponse>(
    async ({ id, body }) => {
      const { data } = await apiClient.post<GlobalLayerApplyResponse>(
        `/global-layer/${id}/apply`,
        body,
      );
      return data;
    },
  );

/** Задание переноса; состояние пары оно не меняет — перечитывать нечего. */
export function useGlobalTransfer() {
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: GlobalLayerTransferRequest }) => {
      const { data } = await apiClient.post<GlobalLayerTransferResponse>(
        `/global-layer/${id}/transfer`,
        body,
      );
      return data;
    },
    meta: { silentError: true },
  });
}
