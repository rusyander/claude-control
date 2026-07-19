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
        `/scripts/${encodeURIComponent(id ?? '')}`,
      );
      return data.content;
    },
    enabled: Boolean(id),
  });
}

function useScriptMutation<TInput>(request: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scriptsKey });
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
    },
  });
}

export function useSaveScript() {
  return useScriptMutation(async (input: { id?: string; name: string; content: string }) => {
    if (input.id) {
      await apiClient.put(`/scripts/${encodeURIComponent(input.id)}`, { content: input.content });
      return;
    }
    await apiClient.post('/scripts', { name: input.name, content: input.content });
  });
}

export function useDeleteScript() {
  return useScriptMutation(async (id: string) => {
    await apiClient.delete(`/scripts/${encodeURIComponent(id)}`);
  });
}
