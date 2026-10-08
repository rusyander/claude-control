import { useGitAction } from './useGitAction';

/** Переключиться на существующую локальную ветку. */
export function useCheckoutBranch() {
  return useGitAction<{ path: string; branch: string }>('/project-git/checkout');
}
