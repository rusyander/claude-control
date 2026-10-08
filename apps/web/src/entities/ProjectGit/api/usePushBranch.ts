import { useGitAction } from './useGitAction';

/**
 * Отправить текущую ветку. Только её и только вперёд: `--force` не передаётся
 * нигде, а ветка без upstream уходит с `--set-upstream` — иначе первый push
 * новой ветки требовал бы терминала.
 */
export function usePushBranch() {
  return useGitAction<{ path: string }>('/project-git/push');
}
