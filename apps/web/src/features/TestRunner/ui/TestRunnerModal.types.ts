import type { ProjectTestGroup, ProjectTestSharedStep } from '@agentdeck/contracts';

export interface TestRunnerModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  /** Группы нужны за телами кейсов: поинт знает только идентификаторы. */
  groups: ProjectTestGroup[];
  sharedSteps: ProjectTestSharedStep[];
}
