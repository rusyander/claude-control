import type { ProjectTestSharedStep, ProjectTestStep } from '@agentdeck/contracts';

export interface TestCaseStepsProps {
  steps: ProjectTestStep[];
  onChange: (steps: ProjectTestStep[]) => void;
  /** Общие шаги проекта: на них ссылаются, а не копируют текст. */
  sharedSteps: ProjectTestSharedStep[];
  /** Чек-листу ожидание шага не нужно — колонка прячется. */
  withExpected: boolean;
}
