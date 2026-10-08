import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';

/** Забыть авторизацию сервера — удалить сохранённый токен. */
export function useClearOAuth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await apiClient.delete(`/mcp/${encodeURIComponent(id)}/oauth`);
    },
    onSuccess: () => {
      toast.success(i18n.t('mcp.oauthCleared'));
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
    },
  });
}
