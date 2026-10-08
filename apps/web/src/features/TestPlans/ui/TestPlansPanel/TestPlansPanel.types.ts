import type {
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestView,
} from '@agentdeck/contracts';

export interface TestPlansPanelProps {
  projectPath: string | undefined;
  groups: ProjectTestGroup[];
  views: ProjectTestView[];
  environments: ProjectTestEnvironment[];
  /** Запустить агента по плану. */
  onStartAgent: (planId: string, environmentId?: string) => void;
  /** Начать ручной проход по плану — окно прохода открывает владелец экрана. */
  onStartManual: (planId: string, environmentId?: string) => void;
}
