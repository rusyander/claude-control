import type { Project } from '@claude-control/contracts';

export interface ProjectConfigPanelProps {
  /** Выбранный проект — его конфиги показывает и правит панель. */
  project: Project;
}

/** Разделы конфига проекта; `local` — собственный `.claude` проекта, только чтение. */
export type ProjectTab = 'rules' | 'mcp' | 'permissions' | 'local';
