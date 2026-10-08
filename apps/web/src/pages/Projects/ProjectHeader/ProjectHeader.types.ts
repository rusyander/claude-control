import type { Project } from '@agentdeck/contracts';

export interface ProjectHeaderProps {
  project: Project;
  /** Имя CLI, чьи файлы открыты, — только у не-Claude провайдера. */
  providerName?: string;
  /** Убрать проект из реестра: файлы не трогаются, забывается только путь. */
  onRemove: () => void;
  isRemoving: boolean;
}
