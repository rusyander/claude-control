import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@agentdeck/contracts';
import { ApiError, api } from '../../shared/api/client';
import { REGISTRY_KEY } from './useProjectRegistry';

/**
 * Добавить папку в реестр панели. Повтор той же папки сервер отклоняет 409 с
 * уже существующей записью — для человека это не ошибка: проект в списке, чего
 * он и хотел.
 */
export function useAddProject(): ReturnType<typeof useMutation<void, Error, string>> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (path) => {
      try {
        await api.post<Project>('/projects', { path });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return;
        throw error;
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: REGISTRY_KEY }),
  });
}
