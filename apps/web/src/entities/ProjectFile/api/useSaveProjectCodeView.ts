import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { ProjectCodeView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { ROOT_KEY } from './ProjectFileApi.constants';

/**
 * Запомнить снимок. Кэш запроса обновляем сами, а не перечитыванием: ответ
 * сервера ничего нового не несёт, а лишний круг сети на каждое раскрытие папки
 * — плата ни за что.
 */
export function useSaveProjectCodeView(path: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (view: ProjectCodeView) => {
      await apiClient.put('/project-files/view', { path, view });
      return view;
    },
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectCodeView | null>([ROOT_KEY, 'view', path ?? ''], view);
    },
    // Молча: это фоновая память об открытом, а не действие человека. Тост на
    // каждое раскрытие папки, когда сервер недоступен, был бы шумом о том, чего
    // никто не просил.
    meta: { silentError: true },
  });
}
