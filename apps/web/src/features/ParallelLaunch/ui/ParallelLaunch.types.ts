import type { ProjectInfo } from '@entities/Project';

export interface ParallelLaunchProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectInfo[];
  /** Запустить один и тот же запрос в выбранных проектах. */
  onLaunch: (selected: ProjectInfo[], prompt: string, allowEdits: boolean) => void;
}
