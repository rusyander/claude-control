import type { ProjectRunnerView } from '@claude-control/contracts';

/** Ссылка на запущенную цель в ряду вкладки. */
export interface RunnerChipProps {
  path: string;
  run: ProjectRunnerView;
  /** Показывать ли имя цели: у монорепы важно, у одиночного проекта — шум. */
  withName: boolean;
}
