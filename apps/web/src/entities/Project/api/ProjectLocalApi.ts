import { useQuery } from '@tanstack/react-query';
import type { ProjectLocalConfig } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Собственный `.claude` проекта — скиллы, хуки и правила, которые Claude Code
 * загружает из каталога репозитория поверх пользовательского набора. Только
 * чтение: файлы принадлежат гиту проекта и правятся там, поэтому мутаций у
 * этого API нет.
 *
 * Два адреса одного ответа: по id из реестра — для страницы проектов, по
 * абсолютному пути — для карточки группы, где привязка хранит именно путь, а
 * проекта в реестре может и не быть.
 */

export function useProjectLocal(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectLocal(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectLocalConfig>(`/projects/${projectId}/local`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

export function useProjectLocalByPath(path: string) {
  return useQuery({
    queryKey: queryKeys.projectLocalByPath(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectLocalConfig>('/projects/local', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}
