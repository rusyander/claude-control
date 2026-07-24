import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderMcpInfo,
  UniversalMcpServerDraft,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Универсальные MCP-серверы активного провайдера (Gemini/Codex). Отдельный от
 * Claude набор запросов: Claude MCP живёт на богатых роутах `/api/mcp` со своей
 * страницей — клиент выбирает набор по активному провайдеру. GET возвращает не
 * просто список, а `ProviderMcpInfo` (серверы + метаданные: формат, путь, найден
 * ли CLI, флаг readOnly), поэтому обычную фабрику сущностей здесь не используем.
 */

async function getProviderMcp(): Promise<ProviderMcpInfo> {
  const { data } = await apiClient.get<ProviderMcpInfo>('/provider-mcp');
  return data;
}

export function useProviderMcp() {
  return useQuery({ queryKey: queryKeys.providerMcp, queryFn: getProviderMcp });
}

/** Инвалидация после записи: список раздела + сводка на главной. */
function useInvalidateProviderMcp() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerMcp });
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
  };
}

export function useCreateProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (draft: UniversalMcpServerDraft): Promise<WriteResult> => {
      const { data } = await apiClient.post<WriteResult>('/provider-mcp', draft);
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.created' },
  });
}

export function useUpdateProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      draft: UniversalMcpServerDraft;
    }): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(
        `/provider-mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.saved' },
  });
}

export function useDeleteProviderMcp() {
  const invalidate = useInvalidateProviderMcp();
  return useMutation({
    mutationFn: async (id: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(
        `/provider-mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: invalidate,
    meta: { successMessage: 'toasts.deleted' },
  });
}
