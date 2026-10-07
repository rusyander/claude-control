import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KitItemContent, KitResponse, KitTwinKind } from '@agentdeck/contracts/kit';
import type { KitMode } from '@agentdeck/contracts/local-models';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getKit(): Promise<KitResponse> {
  const { data } = await apiClient.get<KitResponse>('/kit');
  return data;
}

async function getItem(id: string): Promise<KitItemContent> {
  const { data } = await apiClient.get<KitItemContent>('/kit/item', { params: { id } });
  return data;
}

export function useKit() {
  return useQuery({ queryKey: queryKeys.kit, queryFn: getKit });
}

export function useKitItem(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.kit, 'item', id ?? ''],
    queryFn: () => getItem(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Каждая правка отвечает свежим набором целиком: его и кладём в кэш, а текст
 * элемента перечитываем — копия «моё» могла появиться или уйти в архив.
 */
function useKitMutation<TInput>(run: (input: TInput) => Promise<KitResponse>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (kit) => queryClient.setQueryData(queryKeys.kit, kit),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.kit }),
  });
}

export const useSetKitProviderMode = () =>
  useKitMutation<{ provider: string; mode: KitMode }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/mode', body);
    return data;
  });

export const useSaveKitItem = () =>
  useKitMutation<{ id: string; content: string }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/item', body);
    return data;
  });

export const useResetKitItem = () =>
  useKitMutation<string>(async (id) => {
    const { data } = await apiClient.delete<KitResponse>('/kit/item', { params: { id } });
    return data;
  });

export const useToggleKitItem = () =>
  useKitMutation<{ id: string; enabled: boolean }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/item/enabled', body);
    return data;
  });

export const useKitConflictWinner = () =>
  useKitMutation<{ id: string; winner: 'user' | 'kit' }>(async (body) => {
    const { data } = await apiClient.put<KitResponse>('/kit/conflict', body);
    return data;
  });

/** Ответ записи в глобальный слой: набор целиком и путь резервной копии, если она была. */
export interface KitExportResult {
  kit: KitResponse;
  backup?: string;
}

export function useExportKitItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<KitExportResult>('/kit/global/export', { id });
      return data;
    },
    onSuccess: (result) => queryClient.setQueryData(queryKeys.kit, result.kit),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.kit }),
  });
}

export const useImportKitItem = () =>
  useKitMutation<{ kind: KitTwinKind; name: string }>(async (body) => {
    const { data } = await apiClient.post<KitResponse>('/kit/global/import', body);
    return data;
  });
