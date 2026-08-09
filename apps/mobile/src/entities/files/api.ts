import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  ProjectFileChanges,
  ProjectFileContent,
  ProjectFileTree,
} from '@claude-control/contracts';
import { api } from '../../shared/api/client';

/**
 * Окно кода: дерево проекта, список изменённого агентом и содержимое файла.
 *
 * В приложении оно ТОЛЬКО ДЛЯ ЧТЕНИЯ — сохранения файла здесь нет и не будет:
 * править код с телефона никто не собирался, а кнопка, которой можно случайно
 * задеть чужую работу, ценнее не становится оттого, что она есть.
 */

/** Содержимое одного каталога: дерево грузится по уровню, а не целиком. */
export function useFileTree(
  projectPath: string | undefined,
  dir = '',
): UseQueryResult<ProjectFileTree> {
  return useQuery({
    queryKey: ['project-files', 'tree', projectPath, dir],
    queryFn: () => api.get<ProjectFileTree>('/project-files/tree', { path: projectPath, dir }),
    enabled: Boolean(projectPath),
    staleTime: 30_000,
  });
}

/**
 * Что агент изменил в этом разговоре. База сравнения восстанавливается сервером
 * ОБРАТНЫМ проигрыванием транскрипта, а не из git, — поэтому список честен и в
 * репозитории с грязным рабочим деревом.
 */
export function useFileChanges(
  projectPath: string | undefined,
  chatId: string | undefined,
): UseQueryResult<ProjectFileChanges> {
  return useQuery({
    queryKey: ['project-files', 'changes', projectPath, chatId],
    queryFn: () =>
      api.get<ProjectFileChanges>('/project-files/changes', { path: projectPath, chatId }),
    enabled: Boolean(projectPath),
    staleTime: 10_000,
  });
}

export function useFileContent(
  projectPath: string | undefined,
  file: string | undefined,
  chatId: string | undefined,
): UseQueryResult<ProjectFileContent> {
  return useQuery({
    queryKey: ['project-files', 'content', projectPath, file, chatId],
    queryFn: () =>
      api.get<ProjectFileContent>('/project-files/content', {
        path: projectPath,
        file,
        chatId,
      }),
    enabled: Boolean(projectPath && file),
  });
}
