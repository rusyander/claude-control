import { useGitAction } from './useGitAction';

/** Создать ветку от текущего HEAD и перейти на неё. */
export function useCreateBranch() {
  return useGitAction<{ path: string; name: string }>('/project-git/branch');
}
