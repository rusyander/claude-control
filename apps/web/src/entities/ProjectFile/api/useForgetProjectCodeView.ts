import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { ROOT_KEY } from './ProjectFileApi.constants';

/** Таб закрыли — снимок стирается: следующее открытие начнётся с чистого листа. */
export function useForgetProjectCodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { path: string }) => {
      await apiClient.delete('/project-files/view', { params: { path: input.path } });
      return input;
    },
    onSuccess: (input) => {
      queryClient.removeQueries({ queryKey: [ROOT_KEY, 'view', input.path] });
    },
    // Вкладку закрывают, а не «забывают снимок»: отказ сервера здесь — не то, о
    // чём стоит сообщать поверх уже закрытой вкладки.
    meta: { silentError: true },
  });
}
