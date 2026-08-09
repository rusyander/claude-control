export {
  useProjectGit,
  useCheckoutBranch,
  useCreateBranch,
  useCommitAll,
  usePullChanges,
  usePushBranch,
  projectGitKey,
} from './api/ProjectGitApi';
export type {
  ProjectGitChange,
  ProjectGitFileStatus,
  ProjectGitInfo,
  ProjectGitResult,
} from '@claude-control/contracts';
