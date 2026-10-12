import type { ProjectRunnerTarget } from '@entities/ProjectRunner';

/** «Запустить всё / Остановить всё» над списком целей проекта. */
export interface RunnerGroupActionsProps {
  /** Корень вкладки проекта. */
  path: string;
  targets: ProjectRunnerTarget[];
  /** Сколько целей проекта сейчас работает или поднимается. */
  liveCount: number;
}
