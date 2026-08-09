import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectGitInfo, ProjectGitResult } from '@claude-control/contracts';
import { api } from '../../shared/api/client';

/**
 * Каталоги на машине с панелью: обзор файловой системы для выбора проекта и
 * пульт git выбранного.
 *
 * Проект здесь — это просто путь. Реестра приложение не спрашивает намеренно:
 * работать можно в любой папке, и требовать «сначала заведи проект» на телефоне
 * значило бы упереться в экран, которого тут нет.
 */

export interface DirEntry {
  name: string;
  path: string;
  /** Задано только у файлов; обзор по умолчанию отдаёт одни каталоги. */
  isFile?: boolean;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export function useFsRoots(): UseQueryResult<DirEntry[]> {
  return useQuery({
    queryKey: ['fs', 'roots'],
    queryFn: () => api.get<DirEntry[]>('/fs/roots'),
    staleTime: 60_000,
  });
}

export function useFsList(path: string): UseQueryResult<DirListing> {
  return useQuery({
    queryKey: ['fs', 'list', path],
    queryFn: () => api.get<DirListing>('/fs/list', { path }),
    enabled: Boolean(path),
  });
}

export function useProjectGit(path: string | undefined): UseQueryResult<ProjectGitInfo> {
  return useQuery({
    queryKey: ['project-git', path],
    queryFn: () => api.get<ProjectGitInfo>('/project-git', { path }),
    enabled: Boolean(path),
    staleTime: 10_000,
  });
}

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
