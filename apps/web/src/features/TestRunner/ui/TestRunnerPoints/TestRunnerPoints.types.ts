import type { ProjectTestPoint, ProjectTestPointResult } from '@agentdeck/contracts';

export interface TestRunnerPointsProps {
  points: ProjectTestPoint[];
  /** Уже отправленные результаты — по ним рисуются галочки списка. */
  results: ProjectTestPointResult[];
  index: number;
  onSelect: (index: number) => void;
}
