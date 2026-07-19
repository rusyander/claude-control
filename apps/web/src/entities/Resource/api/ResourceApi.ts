import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Файлы ресурса — общий слой для всех видов.
 *
 * Вид передаётся параметром, поэтому один набор запросов обслуживает скиллы,
 * скрипты и плагины: их различия описаны на сервере, а не размазаны по
 * интерфейсу. Новому виду хватит записи в серверном реестре.
 */

export type ResourceKind = 'skill' | 'script' | 'hook' | 'rule' | 'mcp' | 'plugin';

export interface ResourceFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Двоичный файл показываем, но не даём править текстом. */
  isBinary: boolean;
}

export interface ResourceFiles {
  files: ResourceFile[];
  /** Можно ли менять состав: у плагинов файлы чужие. */
  isWritable: boolean;
  /** Файл, который стоит открыть первым. */
  entryFile?: string;
}

function resourceKey(kind: ResourceKind, id: string) {
  return ['resources', kind, id] as const;
}

export function useResourceFiles(kind: ResourceKind, id: string | undefined) {
  return useQuery({
    queryKey: resourceKey(kind, id ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceFiles>(
        `/resources/${kind}/${encodeURIComponent(id ?? '')}/files`,
      );
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useResourceFile(kind: ResourceKind, id: string | undefined, file?: string) {
  return useQuery({
    queryKey: [...resourceKey(kind, id ?? ''), 'file', file],
    queryFn: async () => {
      const { data } = await apiClient.get<{ content: string; isBinary: boolean }>(
        `/resources/${kind}/${encodeURIComponent(id ?? '')}/file`,
        { params: { file } },
      );
      return data;
    },
    enabled: Boolean(id && file),
  });
}

function useResourceMutation<TInput>(
  kind: ResourceKind,
  id: string,
  request: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: resourceKey(kind, id) });
      // Список сущностей показывает число файлов и размер — их тоже освежаем.
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });
}

export function useSaveResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(kind, id, async (input: { file: string; content: string }) => {
    await apiClient.put(`/resources/${kind}/${encodeURIComponent(id)}/file`, input);
  });
}

export function useDeleteResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(kind, id, async (file: string) => {
    await apiClient.delete(`/resources/${kind}/${encodeURIComponent(id)}/file`, {
      params: { file },
    });
  });
}

export function useMoveResourceFile(kind: ResourceKind, id: string) {
  return useResourceMutation(kind, id, async (input: { from: string; to: string }) => {
    await apiClient.post(`/resources/${kind}/${encodeURIComponent(id)}/move`, input);
  });
}
