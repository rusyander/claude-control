import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { cascadeKey } from '../lib/cascadeKey';

export function useSetCascadeRule(path: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.put<{ enabled: boolean; project: string }>('/chat/cascade', {
        path,
        enabled,
      });
      return data;
    },
    // Ответ и есть новое состояние: лишний запрос следом здесь не нужен, а вот
    // соседние вкладки того же проекта должны увидеть смену — их ключ другой,
    // поэтому гасим всё семейство.
    onSuccess: (data) => {
      queryClient.setQueryData(cascadeKey(path), data);
      void queryClient.invalidateQueries({ queryKey: ['chat-cascade'] });
    },
  });
}
