import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project, ProjectDraft } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Реестр проектов уровня конфигурации — список запомненных путей к каталогам
 * проектов. Сам список живёт в состоянии панели; здесь только его чтение и
 * правка (добавить/забыть). Файлы проекта при удалении не трогаем — забываем путь.
 */

/** Зарегистрированные проекты. */
export function useProjectRegistry() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async () => {
      const { data } = await apiClient.get<Project[]>('/projects');
      return data;
    },
  });
}

/** Добавить проект в реестр по пути к его каталогу. */
export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProjectDraft) => {
      const { data } = await apiClient.post<Project>('/projects', draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    meta: { successMessage: 'toasts.created' },
  });
}

/** Забыть проект: убрать из реестра, файлы проекта не трогая. */
export function useRemoveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/projects/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
