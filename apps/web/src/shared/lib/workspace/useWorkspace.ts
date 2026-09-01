import { useSyncExternalStore } from 'react';
import { HOME_TAB_ID, type ProjectTab, type WorkspaceState } from './workspace.types';
import { getWorkspaceState, subscribeWorkspace, workspace } from './workspaceStore';

export interface UseWorkspace {
  state: WorkspaceState;
  /** Активный проект-таб или undefined, когда активен домашний. */
  activeProject: ProjectTab | undefined;
  isHome: boolean;
  openProject: (path: string, name: string) => string;
  closeProject: (id: string) => void;
  activate: (id: string) => void;
  /** Запомнить разговор, открытый в этой вкладке (пусто — забыть). */
  rememberView: (tabId: string, chatId: string | undefined) => void;
}

/** Подписка на состояние рабочего пространства для интерфейса. */
export function useWorkspace(): UseWorkspace {
  const state = useSyncExternalStore(subscribeWorkspace, getWorkspaceState, getWorkspaceState);
  const activeProject = state.projectTabs.find((tab) => tab.id === state.activeTabId);

  return {
    state,
    activeProject,
    isHome: state.activeTabId === HOME_TAB_ID,
    openProject: workspace.openProject,
    closeProject: workspace.closeProject,
    activate: workspace.activate,
    rememberView: workspace.rememberView,
  };
}
