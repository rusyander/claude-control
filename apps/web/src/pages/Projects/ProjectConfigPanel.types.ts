import type { Project } from '@claude-control/contracts';

export interface ProjectConfigPanelProps {
  /** Выбранный проект — его конфиги показывает и правит панель. */
  project: Project;
}

/** Разделы конфига проекта. */
export type ProjectTab = 'rules' | 'mcp' | 'permissions';
