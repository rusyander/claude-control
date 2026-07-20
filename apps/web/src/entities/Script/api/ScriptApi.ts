import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface ScriptFile {
  id: string;
  name: string;
  extension: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  description?: string;
  isUsed: boolean;
}

const scriptsKey = ['scripts'] as const;

/** Кодируем каждый сегмент, но сохраняем слэши: id скрипта может быть вложенным путём. */
function encodeScriptId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

export function useScripts() {
  return useQuery({
    queryKey: scriptsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ScriptFile[]>('/scripts');
      return data;
    },
  });
}

/** Содержимое файла грузится отдельно: список не должен тянуть весь код. */
export function useScriptContent(id: string | undefined) {
  return useQuery({
    queryKey: ['scripts', id, 'content'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ content: string }>(
        `/scripts/${encodeScriptId(id ?? '')}`,
      );
      return data.content;
    },
    enabled: Boolean(id),
  });
}

function useScriptMutation<TInput>(
  request: (input: TInput) => Promise<unknown>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scriptsKey });
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
    },
    meta: { successMessage },
  });
}

export function useSaveScript() {
  return useScriptMutation(async (input: { id?: string; name: string; content: string }) => {
    if (input.id) {
      await apiClient.put(`/scripts/${encodeScriptId(input.id)}`, { content: input.content });
      return;
    }
    await apiClient.post('/scripts', { name: input.name, content: input.content });
  }, 'toasts.saved');
}

export function useDeleteScript() {
  return useScriptMutation(async (id: string) => {
    await apiClient.delete(`/scripts/${encodeScriptId(id)}`);
  }, 'toasts.deleted');
}
