import type { ProjectRunnerTarget, ProjectRunnerView } from '@claude-control/contracts';

/** Строка одной цели в поповере настроек запуска. */
export interface RunnerTargetRowProps {
  /** Корень проекта: цель адресуется парой «корень + подпапка». */
  path: string;
  target: ProjectRunnerTarget;
  /** Состояние запуска этой цели, если она запущена. */
  run?: ProjectRunnerView;
  /** Разворачивать ли поля команды и порта сразу (у единственной цели — да). */
  defaultOpen: boolean;
}
