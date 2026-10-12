import type { ProjectRunnerTarget, ProjectRunnerView } from '@agentdeck/contracts';

/** Строка одной цели в поповере настроек запуска. */
export interface RunnerTargetRowProps {
  /** Корень проекта: цель адресуется парой «корень + подпапка». */
  path: string;
  target: ProjectRunnerTarget;
  /** Состояние запуска этой цели, если она запущена. */
  run?: ProjectRunnerView;
  /** Разворачивать ли поля команды и порта сразу (у единственной цели — да). */
  defaultOpen: boolean;
  /** Показывать галочку «в «Запустить всё»» — только когда целей больше одной. */
  showGroup: boolean;
}
