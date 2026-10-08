import { useGitAction } from './useGitAction';

/**
 * Подтянуть чужие коммиты. Без `branch` — обычный `git pull` в текущей ветке,
 * с `branch` — из этой ветки удалённого.
 */
export function usePullChanges() {
  return useGitAction<{ path: string; branch?: string }>('/project-git/pull');
}
