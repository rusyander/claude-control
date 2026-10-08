import { useGitAction } from './useGitAction';

/** Закоммитить все изменения рабочего дерева. */
export function useCommitAll() {
  return useGitAction<{ path: string; message: string }>('/project-git/commit');
}
