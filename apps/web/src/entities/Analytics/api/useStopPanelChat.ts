import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** Стоп чата панели — тот же, что кнопкой «Стоп» в самом чате. */
export function useStopPanelChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chatId: string): Promise<{ ok: boolean }> => {
      const { data } = await apiClient.post<{ ok: boolean }>(
        `/chat/${encodeURIComponent(chatId)}/stop`,
      );
      return data;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['analytics'] }),
    meta: { silentError: true },
  });
}
