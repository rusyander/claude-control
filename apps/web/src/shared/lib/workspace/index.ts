export { HOME_TAB_ID } from './workspace.types';
export type { ProjectTab, WorkspaceState } from './workspace.types';
export {
  workspace,
  getWorkspaceState,
  subscribeWorkspace,
  normalizeProjectPath,
  projectShortName,
  openProjectTab,
  closeProjectTab,
  activateTab,
  rememberTabView,
  sanitizeState,
} from './workspaceStore';
export { useWorkspace, type UseWorkspace } from './useWorkspace';
