import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import type { SplitGroupCleaned } from '@agentdeck/contracts/chat-handoff';
import { git } from '../project-git/exec.ts';
import { removeWorktree } from '../project-git/worktrees.ts';

/**
 * Уборка копии закрытой группы (Д19) — git-половина. Решение «можно ли» живёт в
 * конвейере (`SplitConveyor.cleanup`), здесь только то, что делает git.
 *
 * Копию убирает `removeWorktree` без `--force`: незакоммиченная работа человека
 * — не мусор, и отказ git уходит ему как есть. Ветку удаляем только ПУСТУЮ —
 * вершина которой уже есть в основной копии: тогда удаление не теряет ни одного
 * коммита. Ветка со своей работой и ветка MR остаются: слить их или выбросить
 * решает человек, а не панель.
 */
export async function removeGroupCopy(input: {
  projectPath: string;
  path: string;
  branch: string;
  /** Ветка MR (у связи группы есть ревью): её панель не трогает никогда. */
  keepBranch: boolean;
  claudeJsonPath?: string;
  mirror?: WorktreeMirrorSettings;
}): Promise<SplitGroupCleaned['branch']> {
  const { projectPath, path, branch } = input;
  await removeWorktree(projectPath, path, false, input.claudeJsonPath, input.mirror);
  if (input.keepBranch) return 'mr';
  const ref = `refs/heads/${branch}`;
  try {
    await git(projectPath, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return 'none';
  }
  try {
    // Своих коммитов у ветки нет, если её вершина — предок HEAD основной копии.
    await git(projectPath, ['merge-base', '--is-ancestor', ref, 'HEAD']);
  } catch {
    return 'kept';
  }
  await git(projectPath, ['branch', '-d', branch]);
  return 'deleted';
}
