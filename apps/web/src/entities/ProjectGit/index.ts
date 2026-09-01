export {
  useProjectGit,
  useCheckoutBranch,
  useCreateBranch,
  useCommitAll,
  usePullChanges,
  usePushBranch,
  useProjectWorktrees,
  useAddWorktree,
  useRemoveWorktree,
  projectGitKey,
} from './api/ProjectGitApi';
export type {
  ProjectGitChange,
  ProjectGitFileStatus,
  ProjectGitInfo,
  ProjectGitResult,
  ProjectWorktree,
  ProjectWorktreesInfo,
  ProjectWorktreesResult,
} from '@claude-control/contracts';
