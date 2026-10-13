import type { ProjectInfo } from '@entities/Project';
import type { RunStatus } from '@shared/lib/agent-runs';

export interface ProjectRowProps {
  project: ProjectInfo;
  isActive: boolean;
  status: RunStatus;
  language: string;
  onOpen: () => void;
  /** Проект есть на странице «Проекты» — у строки метка вместо кнопки добавления. */
  isRegistered?: boolean;
  /** Добавить проект на страницу «Проекты»; не задано — кнопки нет. */
  onRegister?: () => void;
  isRegistering?: boolean;
}
