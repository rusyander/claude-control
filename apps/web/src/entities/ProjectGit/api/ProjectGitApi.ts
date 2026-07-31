import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectGitInfo, ProjectGitResult } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Git выбранного проекта: состояние (ветка, список веток, какие файлы изменены,
 * отставание от удалённого) и четыре операции — переключиться, создать ветку,
 * закоммитить, подтянуть чужое.
 *
 * Состояние перечитывается по фокусу окна и с редким поллингом: ветку и файлы
 * человек чаще меняет в терминале и в редакторе, чем здесь, — панель не должна
 * показывать вчерашнюю ветку. Каждая операция возвращает уже НОВОЕ состояние,
 * поэтому кэш обновляется ответом, без лишнего запроса следом.
 */

export const projectGitKey = ['project-git'] as const;

/** Ключ кэша на проект — по нормализованному пути. */
function keyFor(path: string | undefined): readonly unknown[] {
  return [...projectGitKey, path ? normalizeProjectPath(path) : ''];
}

/** Состояние репозитория проекта; `isRepo:false` — пульт не показывается. */
export function useProjectGit(path: string | undefined) {
  return useQuery({
    queryKey: keyFor(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectGitInfo>('/project-git', { params: { path } });
      return data;
    },
    enabled: Boolean(path),
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });
}

/** Общая обвязка операции записи: ответ кладём в кэш как новое состояние. */
function useGitAction<TBody extends { path: string }>(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const { data } = await apiClient.post<ProjectGitResult>(url, body);
      return data;
    },
    onSuccess: (result, body) => {
      queryClient.setQueryData(keyFor(body.path), result.info);
    },
  });
}

/** Переключиться на существующую локальную ветку. */
export function useCheckoutBranch() {
  return useGitAction<{ path: string; branch: string }>('/project-git/checkout');
}

/** Создать ветку от текущего HEAD и перейти на неё. */
export function useCreateBranch() {
  return useGitAction<{ path: string; name: string }>('/project-git/branch');
}

/** Закоммитить все изменения рабочего дерева. */
export function useCommitAll() {
  return useGitAction<{ path: string; message: string }>('/project-git/commit');
}

/**
 * Подтянуть чужие коммиты. Без `branch` — обычный `git pull` в текущей ветке,
 * с `branch` — из этой ветки удалённого.
 */
export function usePullChanges() {
  return useGitAction<{ path: string; branch?: string }>('/project-git/pull');
}
