import type { Project } from '@agentdeck/contracts';

export interface ProjectConfigPanelProps {
  /** Выбранный проект — его конфиги показывает и правит панель. */
  project: Project;
  /** Убрать проект из реестра — кнопка в шапке проекта. */
  onRemove: () => void;
  isRemoving: boolean;
}

/**
 * Разделы конфига проекта: `rules` — файл инструкций (CLAUDE.md/AGENTS.md),
 * `local` — собственный `.claude` проекта, только чтение.
 */
export type ProjectTab = 'rules' | 'mcp' | 'permissions' | 'local';
