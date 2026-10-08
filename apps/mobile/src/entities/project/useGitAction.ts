import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectGitResult } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Операции git. Все они меняют состояние репозитория, поэтому после каждой
 * перечитываем не только сам пульт, но и дерево файлов: коммит и переключение
 * ветки меняют то, что показывает окно кода.
 */
export function useGitAction(
  action: 'checkout' | 'branch' | 'commit' | 'pull' | 'push',
): ReturnType<typeof useMutation<ProjectGitResult, Error, Record<string, unknown>>> {
  const queryClient = useQueryClient();
  return useMutation<ProjectGitResult, Error, Record<string, unknown>>({
    mutationFn: (body) => api.post<ProjectGitResult>(`/project-git/${action}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-git'] });
      void queryClient.invalidateQueries({ queryKey: ['project-files'] });
    },
  });
}
